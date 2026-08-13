// Liberation DMX - Chataigne custom module script
//
// Copyright (C) 2026 Jon Sands
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later
// version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License along with
// this program. If not, see <https://www.gnu.org/licenses/>.
//
// Streams Liberation's "DMX Input" fixture profiles (Basic 16ch / Extended 32ch)
// out of Chataigne's DMX module. One Chataigne zone == one Liberation DMX Input
// profile row == one consecutive block of channels in one universe.
//
// Nothing here polls or re-sends on a timer. The DMX module's own send thread hands
// every output universe to the device at the module's "Send Rate", and the device's
// sender thread emits whatever it was handed at its own "Send Rate" (a separate
// parameter under the device). Both are 44 Hz. So the channel values written here keep
// flowing and Liberation never sees the input go stale (it disables a zone after 2 s
// without fresh data).
//
// That same continuous re-send is why channels have to be actively released: a zone
// that is deleted, shrunk or re-addressed would otherwise keep streaming its last
// values - including Arm 255 - with nothing left in the UI to turn it off. Every block
// this script writes is remembered in sentBlocks, and vacated channels are zeroed.
// (Turning the module off, deleting it or closing the project needs no such handling:
// the send thread stops, so Liberation disarms the zone on its own 2 s timeout.)
//
// See CHANNEL_MAP.md for the channel table and the value conversions.

// ============================================================
// Constants
// ============================================================
var MAX_ZONES = 8;

var DECK_COLS = 8;                 // deck columns one Gobo Bank page covers
var DECK_ROWS = 5;                 // clip deck rows - the deck is this tall, always
var SLOTS_PER_PAGE = 40;           // DECK_COLS * DECK_ROWS
var NUM_FX = 4;

// Liberation labels every clip with the 0-based (x, y) it occupies on the deck - the
// pair its clip settings header prints as "CLIP SETTINGS 21 1". x counts deck columns
// across the whole deck, y is the row. That is the module's only way of naming a clip:
// pages are a detail of the wire format, worked out on the way out in buildZoneBytes.
//   bank = floor(x / DECK_COLS),  slot = (x % DECK_COLS) * DECK_ROWS + y + 1
var MAX_BANKS = 256;               // Gobo Bank is one 8-bit channel
var MAX_DECK_COLUMNS = MAX_BANKS * DECK_COLS;
var MAX_CLIP_X = MAX_DECK_COLUMNS - 1;
var MAX_CLIP_Y = DECK_ROWS - 1;
var DEFAULT_DECK_COLUMNS = 96;     // Liberation's own factory deck is 89 columns wide
var CLIP_NUMBER_NONE = -1;         // an (x, y) pair has no way to say "no clip", so -1 does it

// Enum option data is the value we actually work with: an Enum's get() returns its
// DATA, not its key (EnumParameter::getValue -> getValueData), and command callbacks
// receive the same. So every enum here carries its meaning in the data: profile data
// is the block size and clip data is the whole-deck clip number.
// Use setData() to write one, set() would expect a key.
var PROFILE_EXTENDED_SIZE = 32;
var PROFILE_BASIC_SIZE = 16;
var PROFILE_EXTENDED_KEY = "Extended 32ch";
var PROFILE_BASIC_KEY = "Basic 16ch";

// Channel offsets, 1-based inside a zone's block
var CH_ARM = 1;
var CH_INTENSITY = 2;
var CH_GOBO_BANK = 3;
var CH_GOBO_SELECT = 4;
var CH_RED = 5;
var CH_GREEN = 6;
var CH_BLUE = 7;
var CH_COLOUR_BLEND = 8;
var CH_ZOOM = 9;
var CH_SCALE_X = 10;
var CH_SCALE_Y = 11;
var CH_POS_X_COARSE = 12;
var CH_POS_X_FINE = 13;
var CH_POS_Y_COARSE = 14;
var CH_POS_Y_FINE = 15;
var CH_ROTATION = 16;
var CH_FX_BASE = 17;               // 3 channels per FX slot: level, param 1, param 2
var CH_RESERVED_1 = 29;
var CH_RESERVED_2 = 30;
var CH_TEMPO_COARSE = 31;
var CH_TEMPO_FINE = 32;

var CLIP_NONE_KEY = "None (no clip)";

// ============================================================
// State
// ============================================================
var ready = false;                 // init() finished
var suspendUpdates = false;        // guards against re-entry while the script writes parameters
var warnedMissingZones = [];       // zone numbers already warned about, cleared on rebuild
var warnedAddressing = [];         // addressing warnings already logged, cleared on rebuild

// The channels each zone currently owns on the wire: sentBlocks[zone] is either null or
// [universe, startChannel, size], recorded when a block is actually sent. Anything the
// zone stops covering has to be zeroed, or the DMX module keeps re-sending it forever.
// Filled here rather than in init() so it is never read short: a parameter restored
// while a project loads can reach the send path before init() has run.
var sentBlocks = [];
for (var zi = 0; zi <= MAX_ZONES; zi++) sentBlocks.push(null);

var BLOCK_UNIVERSE = 0;
var BLOCK_START = 1;
var BLOCK_SIZE = 2;

// sendUniverse() silently does nothing when the module holds no matching Output
// Universe, and that is exactly the state right after a project loads: this script's
// init() runs when the module is first created, before the project restores its
// universes, so the opening push can land nowhere. Remember that it happened and
// re-push on the next message-thread event so the zones recover on their own.
// (A timed retry is not an option - script update() runs on a background thread and
// Chataigne's script engine lock is disabled, so it would race the message thread.)
var pendingFullPush = false;
var universesVerified = false;     // once true, the lookup stays out of the hot path

// ============================================================
// Entry points
// ============================================================
function init() {
	suspendUpdates = false;                // recover if a previous run died mid-update
	rebuildZones();
	ready = true;
	script.log("Liberation DMX ready - " + toInt(getSetupValue("Zone Count", 0)) + " zone(s). Use 'Log Addressing' to print the channel map for Liberation's DMX Input window.");
}

function moduleParameterChanged(param) {
	var parent = param.getParent();
	if (parent == null) return;

	// Setup is handled before the suspend guard: the script never writes these, and it
	// keeps 'Rebuild Zones' working as a recovery button if suspendUpdates ever sticks.
	var setup = getSetupContainer();
	if (setup != null && parent.is(setup)) {
		setupParameterChanged(param.niceName);
		return;
	}

	var glob = getGlobalContainer();
	if (glob != null && parent.is(glob)) {
		if (param.niceName == "Master Intensity") pushAllZones();  // the follow toggles act on the next clip change
		return;
	}

	if (suspendUpdates || !ready) return;

	// first message-thread event after a load where the opening push found no universe
	if (pendingFullPush) pushAllZones();

	var zoneIndex = zoneIndexForParam(param, parent);
	if (zoneIndex <= 0) return;

	var name = param.niceName;
	if (name == "Profile" || name == "Universe" || name == "Start Address") {
		// block size or placement changed - re-stack everything, then re-send all zones
		applyAddressing();
		pushAllZones();
		validateAddressing();
		return;
	}

	if (name == "Clip") {
		syncClipNumber(zoneIndex);
		applyClipFollows(zoneIndex);
	} else if (name == "Clip X" || name == "Clip Y") {
		applyClipNumber(zoneIndex, name);
	}

	pushZone(zoneIndex);
}

function setupParameterChanged(name) {
	if (name == "Zone Count" || name == "New Zone Profile" || name == "Deck Columns") {
		rebuildZones();                        // Deck Columns resizes every zone's clip list
	} else if (name == "Auto Address" || name == "Base Universe" || name == "Base Address") {
		applyAddressing();
		pushAllZones();
		validateAddressing();
	} else if (name == "Rebuild Zones") {
		rebuildZones();
	} else if (name == "Log Addressing") {
		logAddressing();
	}
}

// ============================================================
// The clip list
// ============================================================
// One flat list of every clip on the deck, named the way Liberation names it. Options
// run down each column in turn, so an option's index is a whole-deck clip number:
//   index n  ->  x = floor((n - 1) / DECK_ROWS),  y = (n - 1) % DECK_ROWS
// Index 0 is "no clip". Nothing else is needed to place a clip - the page it happens to
// fall on is arithmetic, done once on the way to the wire.
// The labels are terse on purpose: an enum's key is also what it answers to over OSC,
// and "21-1" is something you can type into a message by hand.
function clipKeys() {
	var cols = deckColumns();
	var keys = [CLIP_NONE_KEY];
	for (var x = 0; x < cols; x++) {
		for (var y = 0; y < DECK_ROWS; y++) keys.push(toInt(x) + "-" + toInt(y));
	}
	return keys;
}

function clipIndexFor(x, y) { return toInt(x * DECK_ROWS + y + 1); }
function clipXForIndex(n) { return toInt(Math.floor((n - 1) / DECK_ROWS)); }
function clipYForIndex(n) { return toInt((n - 1) % DECK_ROWS); }

// How wide the user's deck is. Only sizes the list - a deck narrower than a zone's
// current clip drops that zone to "no clip", since the option it pointed at is gone.
function deckColumns() {
	return clampInt(toInt(getSetupValue("Deck Columns", DEFAULT_DECK_COLUMNS)), 1, MAX_DECK_COLUMNS);
}

function lastClipIndex() { return toInt(deckColumns() * DECK_ROWS); }

// Gobo Select is a 1-255 channel divided across 40 slots:
//   slot = 1 + floor((gobo - 1) * 40 / 255)
// Each slot owns a band of ~6.375 DMX steps, so aim at the middle of the band -
// rounding to an edge would land on the neighbouring clip.
function goboValueForSlot(slot) {
	if (slot <= 0) return 0;
	return clampInt(1 + Math.round((2 * slot - 1) * 255 / (2 * SLOTS_PER_PAGE)), 1, 255);
}

// ============================================================
// Zone tree
// ============================================================
function rebuildZones() {
	suspendUpdates = true;
	warnedMissingZones = [];
	warnedAddressing = [];

	var zones = getZonesContainer();
	if (zones == null) zones = local.parameters.addContainer("Zones");

	var count = clampInt(toInt(getSetupValue("Zone Count", 1)), 0, MAX_ZONES);

	for (var i = count + 1; i <= MAX_ZONES; i++) zones.removeContainer("Zone " + toInt(i));
	for (var j = 1; j <= count; j++) ensureZone(zones, j);

	suspendUpdates = false;

	applyAddressing();
	pushAllZones();
	validateAddressing();
}

function ensureZone(zones, index) {
	var name = "Zone " + toInt(index);
	var isNewZone = findContainer(zones, name) == null;
	var z = zones.addContainer(name);
	if (isNewZone) z.setCollapsed(index > 1);

	// --- placement ---
	addBool(z, "Enabled", "Stream this zone. When off the zone keeps streaming but its Arm channel is forced to 0, so Liberation stops rendering it.", true);
	addEnum(z, "Profile", "Which Liberation DMX Input profile this zone uses. Must match the profile chosen for this zone in Liberation.", [PROFILE_EXTENDED_KEY, PROFILE_BASIC_KEY], [PROFILE_EXTENDED_SIZE, PROFILE_BASIC_SIZE], isNewZone ? newZoneProfileKey() : "");
	addInt(z, "Universe", "Universe in Liberation's 1-based UI numbering (1 = Art-Net Port-Address 0). Managed automatically unless Setup > Auto Address is off.", 1, 1, 4096);
	addInt(z, "Start Address", "First channel of this zone's block (1-512). Managed automatically unless Setup > Auto Address is off.", 1, 1, 512);

	// --- live control ---
	addBool(z, "Arm", "Arm channel. Liberation only renders this zone's DMX layer when Arm is at least 250, a clip is selected and Intensity is above zero.", false);
	addFloat(z, "Intensity", "0-1 mapped to 0-100% brightness.", 1, 0, 1);
	var migrated = migrateLegacyPage(z);   // must run before the Clip options are rebuilt
	addEnum(z, "Clip", "Every clip on the deck, named the way Liberation names it: right-click a clip in Liberation and its settings header prints the same 'x y' pair. 'None' = no clip / blackout.", clipKeys(), null, "");
	if (migrated >= 0) z.getChild("Clip").setData(migrated);
	addInt(z, "Clip X", "First figure of Liberation's clip number: deck column, 0 = leftmost. Type what Liberation shows and the Clip dropdown follows. -1 = no clip.", CLIP_NUMBER_NONE, CLIP_NUMBER_NONE, deckColumns() - 1);
	addInt(z, "Clip Y", "Second figure of Liberation's clip number: deck row, 0 = top. -1 = no clip.", CLIP_NUMBER_NONE, CLIP_NUMBER_NONE, MAX_CLIP_Y);
	syncClipNumber(index);                 // the Clip dropdown is the source of truth, here and on load
	addColor(z, "Colour", "Desk RGB colour. Alpha is ignored - use Intensity for brightness.", [1, 1, 1, 1]);
	addFloat(z, "Colour Blend", "0 = the clip's own colour, 1 = the desk RGB colour above.", 1, 0, 1);
	addFloat(z, "Zoom", "0 = collapsed, 1 = normal size.", 1, 0, 1);
	addPoint2D(z, "Position", "-1..1 on each axis, (0,0) = centre. +X right, +Y DOWN (Liberation's convention). Sent 16-bit over the coarse + fine channel pairs.", 0, 0, -1, 1);
	addPoint2D(z, "Scale", "Size on each axis: 1 = 100%, the clip as authored (DMX 255). 0 = 0%, nothing renders (DMX 128). -1 = 100% mirrored on that axis (DMX 0).", 1, 1, -1, 1);
	addFloat(z, "Rotation", "Spin: -1 = max counter-clockwise, 0 = stopped, 1 = max clockwise.", 0, -1, 1);
	addBool(z, "Tempo Override", "Extended 32ch only. Off = follow Liberation's tempo. On = drive this zone from Tempo BPM below.", false);
	addFloat(z, "Tempo BPM", "Extended 32ch only. Only sent while Tempo Override is on. Coarse BPM plus a 1/256 fine part.", 120, 1, 255);

	for (var f = 1; f <= NUM_FX; f++) {
		var fxName = "FX " + toInt(f);
		var isNewFX = findContainer(z, fxName) == null;
		var fx = z.addContainer(fxName);
		if (isNewFX) fx.setCollapsed(true);
		addFloat(fx, "Level", "Extended 32ch only. Effect depth / amount for this slot. At 0 the effect is not applied at all.", 0, 0, 1);
		addFloat(fx, "Param 1", "Extended 32ch only. First exposed parameter of this effect. 0.5 is the recommended neutral value (DMX 128).", 0.5, 0, 1);
		addFloat(fx, "Param 2", "Extended 32ch only. Second exposed parameter of this effect. 0.5 is the recommended neutral value (DMX 128).", 0.5, 0, 1);
	}

	return z;
}

function newZoneProfileKey() {
	return toInt(getSetupValue("New Zone Profile", PROFILE_EXTENDED_SIZE)) == PROFILE_BASIC_SIZE ? PROFILE_BASIC_KEY : PROFILE_EXTENDED_KEY;
}

function zoneProfileSize(z) {
	var p = z.getChild("Profile");
	if (p == null) return PROFILE_EXTENDED_SIZE;
	return toInt(p.get()) == PROFILE_BASIC_SIZE ? PROFILE_BASIC_SIZE : PROFILE_EXTENDED_SIZE;
}

// ============================================================
// Clip number (Liberation's "CLIP SETTINGS x y")
// ============================================================
// Clip X / Clip Y are a second, typeable view of the Clip dropdown. The dropdown stays
// the source of truth: it is what goes on the wire, and the pair is written back from it
// on every selection.

// Clip -> Clip X / Clip Y
function syncClipNumber(index) {
	var z = getZoneContainer(index);
	if (z == null) return;

	var cx = z.getChild("Clip X");
	var cy = z.getChild("Clip Y");
	if (cx == null || cy == null) return;

	var n = clampInt(toInt(z.getChild("Clip").get()), 0, lastClipIndex());

	var wasSuspended = suspendUpdates;
	suspendUpdates = true;

	if (n == 0) {
		cx.set(CLIP_NUMBER_NONE);
		cy.set(CLIP_NUMBER_NONE);
	} else {
		cx.set(clipXForIndex(n));
		cy.set(clipYForIndex(n));
	}

	suspendUpdates = wasSuspended;
}

// Clip X / Clip Y -> Clip. 'changed' names the figure the user just typed, or is ""
// when a command set the pair outright.
function applyClipNumber(index, changed) {
	var z = getZoneContainer(index);
	if (z == null) return;

	var cx = z.getChild("Clip X");
	var cy = z.getChild("Clip Y");
	if (cx == null || cy == null) return;

	var x = toInt(cx.get());
	var y = toInt(cy.get());

	// -1 is no clip, but a typed figure only blanks the zone when the -1 is the figure
	// that was typed. Otherwise a zone sitting at -1 / -1 could never be typed back onto
	// the deck: the first figure entered would be stomped by the one still reading -1.
	var none = x < 0 || y < 0;
	if (changed == "Clip X") none = x < 0;
	else if (changed == "Clip Y") none = y < 0;

	var wasSuspended = suspendUpdates;
	suspendUpdates = true;

	if (none) {
		cx.set(CLIP_NUMBER_NONE);
		cy.set(CLIP_NUMBER_NONE);
		z.getChild("Clip").setData(0);
	} else {
		if (x < 0) { x = 0; cx.set(0); }       // the figure not being typed comes back in
		if (y < 0) { y = 0; cy.set(0); }

		x = clampInt(x, 0, deckColumns() - 1); // a command can ask for more deck than there is
		y = clampInt(y, 0, MAX_CLIP_Y);
		cx.set(x);
		cy.set(y);
		z.getChild("Clip").setData(clipIndexFor(x, y));
	}

	applyClipFollows(index);                   // the Clip change path is suspended here
	suspendUpdates = wasSuspended;
}

// Zones saved before 1.7.0 carry a Page enum, and their Clip data is a slot within that
// page rather than a whole-deck number. Fold the two together, then drop Page - it is
// derived from the clip number now. Returns the clip index to restore, or -1 for a zone
// that needs no migration.
function migrateLegacyPage(z) {
	if (findControllable(z, "Page") == null) return -1;

	var slot = clampInt(toInt(containerValue(z, "Clip", 0)), 0, SLOTS_PER_PAGE);
	var index = 0;
	if (slot > 0) {
		var bank = clampInt(toInt(containerValue(z, "Page", 0)), 0, MAX_BANKS - 1);
		index = clipIndexFor(toInt(bank * DECK_COLS + Math.floor((slot - 1) / DECK_ROWS)), toInt((slot - 1) % DECK_ROWS));
	}

	z.removeParameter("Page");
	return clampInt(index, 0, lastClipIndex());
}

// ============================================================
// Clip follow actions
// ============================================================
// Lets a trigger or mapping just set the clip: the zone arms itself and comes up
// at full, instead of needing Arm and Intensity sent alongside every clip change.
// Selecting "None" disarms again, so Clear Clip is a real blackout.
// Runs with updates suspended so the whole change goes out as one push, and it
// restores the previous suspend state because commands call it while suspended.
function applyClipFollows(index) {
	var z = getZoneContainer(index);
	if (z == null) return;

	var armFollows = getGlobalValue("Arm Follows Clip", true);
	var intensityFollows = getGlobalValue("Intensity Follows Clip", true);
	if (!armFollows && !intensityFollows) return;

	var slot = toInt(z.getChild("Clip").get());
	var wasSuspended = suspendUpdates;
	suspendUpdates = true;

	if (armFollows) z.getChild("Arm").set(slot > 0);
	if (intensityFollows && slot > 0) z.getChild("Intensity").set(1);

	suspendUpdates = wasSuspended;
}

// ============================================================
// Addressing
// ============================================================
function applyAddressing() {
	var zones = getZonesContainer();
	if (zones == null) return;

	var setup = getSetupContainer();
	if (setup == null) return;

	var auto = getSetupValue("Auto Address", true);
	var universe = clampInt(toInt(getSetupValue("Base Universe", 1)), 1, 4096);
	var address = clampInt(toInt(getSetupValue("Base Address", 1)), 1, 512);

	// Placement is about to change, so the "every universe we target exists" shortcut is
	// no longer earned - make the next push re-check and defer again if it has to.
	universesVerified = false;

	suspendUpdates = true;

	for (var i = 1; i <= MAX_ZONES; i++) {
		var z = getZoneContainer(i);
		if (z == null) continue;

		var uniParam = z.getChild("Universe");
		var addrParam = z.getChild("Start Address");
		if (uniParam == null || addrParam == null) continue;

		if (auto) {
			var size = zoneProfileSize(z);
			if (address + size - 1 > 512) {       // spill into the next universe
				universe = universe + 1;
				address = 1;
			}
			uniParam.set(universe);
			addrParam.set(address);
			address = address + size;
		}

		// hand-editable only when Auto Address is off
		uniParam.setAttribute("readonly", auto);
		addrParam.setAttribute("readonly", auto);
	}

	suspendUpdates = false;
}

// Called on every addressing change, so each distinct problem is logged once and then
// stays quiet - otherwise dragging a Start Address spinner would fill the log. Rebuild
// Zones and Log Addressing clear the list, so a real re-check always reports again.
function warnAddressing(key, message) {
	if (warnedAddressing.indexOf(key) >= 0) return;
	warnedAddressing.push(key);
	script.logWarning(message);
}

function validateAddressing() {
	var used = [];                                  // "universe:channel" strings already claimed

	for (var i = 1; i <= MAX_ZONES; i++) {
		var z = getZoneContainer(i);
		if (z == null) continue;

		var size = zoneProfileSize(z);
		var universe = toInt(z.getChild("Universe").get());
		var start = toInt(z.getChild("Start Address").get());

		if (start + size - 1 > 512) {
			warnAddressing("overflow:" + toInt(i), "Zone " + toInt(i) + " needs channels " + toInt(start) + "-" + toInt(start + size - 1) + " but a universe only has 512. Lower its Start Address or move it to another universe.");
		}

		for (var c = start; c < start + size && c <= 512; c++) {
			var key = toInt(universe) + ":" + toInt(c);
			if (used.indexOf(key) >= 0) {
				warnAddressing("overlap:" + toInt(i), "Zone " + toInt(i) + " overlaps another zone at universe " + toInt(universe) + ", channel " + toInt(c) + ". Liberation will see both zones fighting over the same channels.");
				break;
			}
			used.push(key);
		}

		if (!outputUniverseExists(universe)) {
			warnAddressing("universe:" + toInt(universe), "Zone " + toInt(i) + " targets universe " + toInt(universe) + " (Art-Net " + artnetSignatureString(universe) + ") but the module has no matching Output Universe, so nothing will be sent. Add it under Module Parameters > Output Universes, then hit Rebuild Zones.");
		}

		// Scale 0 on both axes is DMX 128, which Liberation renders as 0% - armed but invisible.
		// Catches projects saved before 1.5.0, when 0 was this module's (wrong) neutral default.
		var scale = z.getChild("Scale").get();
		if (scale[0] == 0 && scale[1] == 0) {
			warnAddressing("scalezero:" + toInt(i), "Zone " + toInt(i) + " has Scale at 0 on both axes, which Liberation renders as 0% size - the zone will arm but stay invisible. Set Scale to 1 for the clip at its authored size.");
		}
	}
}

function logAddressing() {
	warnedAddressing = [];                          // this button is the re-check - always report
	script.log("--- Liberation DMX addressing (set these in Liberation's DMX Input window) ---");
	var any = false;
	for (var i = 1; i <= MAX_ZONES; i++) {
		var z = getZoneContainer(i);
		if (z == null) continue;
		any = true;
		var size = zoneProfileSize(z);
		var universe = toInt(z.getChild("Universe").get());
		var start = toInt(z.getChild("Start Address").get());
		script.log("Zone " + toInt(i) + " : universe " + toInt(universe) + " (Art-Net " + artnetSignatureString(universe) + "), channels " + toInt(start) + "-" + toInt(start + size - 1) + ", profile " + (size == 16 ? PROFILE_BASIC_KEY : PROFILE_EXTENDED_KEY) + (z.getChild("Enabled").get() ? "" : " [disabled]"));
	}
	if (!any) script.log("No zones. Raise Setup > Zone Count.");
	validateAddressing();
}

// Liberation UI universe (1-based) -> Art-Net Port-Address (0-based) -> Chataigne net/subnet/universe
function universeNet(universe) { return (toInt(universe - 1) >> 8) & 0x7F; }
function universeSubnet(universe) { return (toInt(universe - 1) >> 4) & 0x0F; }
function universeUniverse(universe) { return toInt(universe - 1) & 0x0F; }

function artnetSignatureString(universe) {
	return "net " + toInt(universeNet(universe)) + " / subnet " + toInt(universeSubnet(universe)) + " / universe " + toInt(universeUniverse(universe));
}

function outputUniverseExists(universe) {
	var mgr = findContainer(local.parameters, "Output Universes");
	if (mgr == null) return true;                    // can't tell - don't cry wolf

	var net = universeNet(universe);
	var subnet = universeSubnet(universe);
	var uni = universeUniverse(universe);

	var items = mgr.getContainers();
	for (var i = 0; i < items.length; i++) {
		var n = items[i].getChild("Net");
		var s = items[i].getChild("Subnet");
		var u = items[i].getChild("Universe");
		if (n == null || s == null || u == null) continue;
		if (toInt(n.get()) == net && toInt(s.get()) == subnet && toInt(u.get()) == uni) return true;
	}
	return false;
}

// ============================================================
// Encoding + sending
// ============================================================
function pushAllZones() {
	if (suspendUpdates) return;                      // the caller that suspended will push

	pendingFullPush = false;

	// Release before writing, never interleaved: a zone that shifted down must not be
	// blanked by the neighbour vacating the channels it has just moved into.
	for (var i = 1; i <= MAX_ZONES; i++) if (blockChanged(i)) clearZoneBlock(i);

	var sent = 0;
	for (var j = 1; j <= MAX_ZONES; j++) if (pushZone(j)) sent++;

	// Earned only by a push that actually reached a universe, with nothing left deferred.
	if (sent > 0 && !pendingFullPush) universesVerified = true;
}

// The block pushZone() would write for this zone right now, or null if it would write
// nothing. Returned as [universe, startChannel, size].
function plannedBlock(index) {
	var z = getZoneContainer(index);
	if (z == null) return null;

	var size = zoneProfileSize(z);
	var start = clampInt(toInt(z.getChild("Start Address").get()), 1, 512);
	if (start + size - 1 > 512) return null;         // already warned in validateAddressing()

	return [toInt(z.getChild("Universe").get()), start, size];
}

// Is anything this zone currently holds on the wire about to stop being covered by it?
function blockChanged(index) {
	var prev = sentBlocks[index];
	if (prev == null) return false;

	var next = plannedBlock(index);
	if (next == null) return true;                   // zone deleted, or no longer sendable
	return prev[BLOCK_UNIVERSE] != next[BLOCK_UNIVERSE] || prev[BLOCK_START] != next[BLOCK_START] || prev[BLOCK_SIZE] != next[BLOCK_SIZE];
}

// Zero every channel the zone last claimed. This is what actually disarms Liberation
// when a zone is deleted or moved: Arm sits on the block's first channel, so a block of
// zeros is a disarm, and the module keeps re-sending it from then on.
function clearZoneBlock(index) {
	var b = sentBlocks[index];
	if (b == null) return;
	sentBlocks[index] = null;

	var zeros = [];
	for (var i = 0; i < b[BLOCK_SIZE]; i++) zeros.push(0);

	var universe = b[BLOCK_UNIVERSE];
	local.sendUniverse(universeNet(universe), universeSubnet(universe), universeUniverse(universe), b[BLOCK_START], zeros);
}

function pushZone(index) {
	if (suspendUpdates) return false;

	var z = getZoneContainer(index);
	if (z == null) return false;

	var b = plannedBlock(index);
	if (b == null) return false;

	var universe = b[BLOCK_UNIVERSE];
	if (!universesVerified && !outputUniverseExists(universe)) {
		pendingFullPush = true;                      // retried from moduleParameterChanged
		return false;
	}

	local.sendUniverse(universeNet(universe), universeSubnet(universe), universeUniverse(universe), b[BLOCK_START], buildZoneBytes(z, b[BLOCK_SIZE]));
	sentBlocks[index] = b;
	return true;
}

function buildZoneBytes(z, size) {
	var b = [];
	for (var i = 0; i < size; i++) b.push(0);

	var enabled = z.getChild("Enabled").get();
	var armed = z.getChild("Arm").get();

	// Arm: Liberation enables output at 250-255, disables below
	b[CH_ARM - 1] = (enabled && armed) ? 255 : 0;
	b[CH_INTENSITY - 1] = dmx8FromUnit(z.getChild("Intensity").get() * getGlobalValue("Master Intensity", 1));

	// The one place pages exist: a whole-deck clip number splits into the bank/slot pair
	// the two channels want. No clip leaves both at 0, which is Liberation's blackout.
	var clipIndex = clampInt(toInt(z.getChild("Clip").get()), 0, lastClipIndex());
	if (clipIndex > 0) {
		var clipX = clipXForIndex(clipIndex);
		b[CH_GOBO_BANK - 1] = clampInt(toInt(Math.floor(clipX / DECK_COLS)), 0, MAX_BANKS - 1);
		b[CH_GOBO_SELECT - 1] = goboValueForSlot(toInt((clipX % DECK_COLS) * DECK_ROWS + clipYForIndex(clipIndex) + 1));
	}

	var col = z.getChild("Colour").get();
	b[CH_RED - 1] = dmx8FromUnit(col[0]);
	b[CH_GREEN - 1] = dmx8FromUnit(col[1]);
	b[CH_BLUE - 1] = dmx8FromUnit(col[2]);
	b[CH_COLOUR_BLEND - 1] = dmx8FromUnit(z.getChild("Colour Blend").get());

	b[CH_ZOOM - 1] = dmx8FromUnit(z.getChild("Zoom").get());

	var scale = z.getChild("Scale").get();
	b[CH_SCALE_X - 1] = dmx8FromBipolar(scale[0]);
	b[CH_SCALE_Y - 1] = dmx8FromBipolar(scale[1]);

	// 16-bit position: 0 -> -200, 32768 -> centre, 65535 -> +200, +X right / +Y down
	var pos = z.getChild("Position").get();
	var px = dmx16FromBipolar(pos[0]);
	var py = dmx16FromBipolar(pos[1]);
	b[CH_POS_X_COARSE - 1] = (px >> 8) & 255;
	b[CH_POS_X_FINE - 1] = px & 255;
	b[CH_POS_Y_COARSE - 1] = (py >> 8) & 255;
	b[CH_POS_Y_FINE - 1] = py & 255;

	b[CH_ROTATION - 1] = dmx8FromBipolar(z.getChild("Rotation").get());

	if (size < 32) return b;                          // Basic 16ch stops here

	for (var f = 1; f <= NUM_FX; f++) {
		var fx = findContainer(z, "FX " + toInt(f));
		if (fx == null) continue;
		var base = CH_FX_BASE + (f - 1) * 3;
		b[base - 1] = dmx8FromUnit(fx.getChild("Level").get());
		b[base] = dmx8FromUnit(fx.getChild("Param 1").get());
		b[base + 1] = dmx8FromUnit(fx.getChild("Param 2").get());
	}

	b[CH_RESERVED_1 - 1] = 0;
	b[CH_RESERVED_2 - 1] = 0;

	// Tempo override: coarse 0 = follow Liberation, otherwise bpm = coarse + fine/256
	if (z.getChild("Tempo Override").get()) {
		var bpm = z.getChild("Tempo BPM").get();
		var coarse = clampInt(Math.floor(bpm), 1, 255);
		var fine = clampInt(Math.round((bpm - Math.floor(bpm)) * 256), 0, 255);
		b[CH_TEMPO_COARSE - 1] = coarse;
		b[CH_TEMPO_FINE - 1] = fine;
	} else {
		b[CH_TEMPO_COARSE - 1] = 0;
		b[CH_TEMPO_FINE - 1] = 0;
	}

	return b;
}

// ============================================================
// Command callbacks (names must match module.json "callback")
// ============================================================
function cmdSetArm(zone, on) { setOnZones(zone, "Arm", on); }
function cmdSetIntensity(zone, value) { setOnZones(zone, "Intensity", value); }
function cmdSetEnabled(zone, on) { setOnZones(zone, "Enabled", on); }

function cmdBlackout(zone) { setOnZones(zone, "Arm", false); }

function cmdResetZone(zone) {
	var idx = zoneIndices(zone);
	for (var i = 0; i < idx.length; i++) {
		var z = getZoneContainer(idx[i]);
		suspendUpdates = true;
		z.getChild("Arm").set(false);
		z.getChild("Intensity").set(1);
		z.getChild("Clip").setData(0);
		syncClipNumber(idx[i]);
		z.getChild("Colour").set([1, 1, 1, 1]);
		z.getChild("Colour Blend").set(1);
		z.getChild("Zoom").set(1);
		z.getChild("Position").set(0, 0);
		z.getChild("Scale").set(1, 1);
		z.getChild("Rotation").set(0);
		z.getChild("Tempo Override").set(false);
		z.getChild("Tempo BPM").set(120);
		for (var f = 1; f <= NUM_FX; f++) {
			var fx = findContainer(z, "FX " + toInt(f));
			if (fx == null) continue;
			fx.getChild("Level").set(0);
			fx.getChild("Param 1").set(0.5);
			fx.getChild("Param 2").set(0.5);
		}
		suspendUpdates = false;
		pushZone(idx[i]);
	}
}

// Straight from Liberation's clip settings header. Goes through the Clip X / Clip Y
// parameters so the whole zone lands in the same state as typing the pair by hand.
function cmdSelectClipNumber(zone, x, y) {
	var idx = zoneIndices(zone);
	for (var i = 0; i < idx.length; i++) {
		var z = getZoneContainer(idx[i]);
		suspendUpdates = true;
		z.getChild("Clip X").set(clampInt(x, CLIP_NUMBER_NONE, MAX_CLIP_X));
		z.getChild("Clip Y").set(clampInt(y, CLIP_NUMBER_NONE, MAX_CLIP_Y));
		applyClipNumber(idx[i], "");           // both figures came from the command
		suspendUpdates = false;
		pushZone(idx[i]);
	}
}

function cmdClearClip(zone) { setDataOnZones(zone, "Clip", 0); }

function cmdSetColour(zone, colour) { setOnZones(zone, "Colour", colour); }
function cmdSetColourBlend(zone, value) { setOnZones(zone, "Colour Blend", value); }

function cmdSetPosition(zone, position) { setPoint2DOnZones(zone, "Position", position[0], position[1]); }
function cmdSetPositionX(zone, value) { setPoint2DAxisOnZones(zone, "Position", 0, value); }
function cmdSetPositionY(zone, value) { setPoint2DAxisOnZones(zone, "Position", 1, value); }

function cmdSetScale(zone, scale) { setPoint2DOnZones(zone, "Scale", scale[0], scale[1]); }
function cmdSetScaleX(zone, value) { setPoint2DAxisOnZones(zone, "Scale", 0, value); }
function cmdSetScaleY(zone, value) { setPoint2DAxisOnZones(zone, "Scale", 1, value); }

function cmdSetZoom(zone, value) { setOnZones(zone, "Zoom", value); }
function cmdSetRotation(zone, value) { setOnZones(zone, "Rotation", value); }

function cmdSetFXLevel(zone, fx, value) { setFXParam(zone, fx, "Level", value); }
function cmdSetFXParameter(zone, fx, parameter, value) { setFXParam(zone, fx, "Param " + toInt(parameter), value); }

function cmdClearEffects(zone) {
	var idx = zoneIndices(zone);
	for (var i = 0; i < idx.length; i++) {
		var z = getZoneContainer(idx[i]);
		suspendUpdates = true;
		for (var f = 1; f <= NUM_FX; f++) {
			var fx = findContainer(z, "FX " + toInt(f));
			if (fx != null) fx.getChild("Level").set(0);
		}
		suspendUpdates = false;
		pushZone(idx[i]);
	}
}

function cmdSetTempoOverride(zone, bpm) {
	var idx = zoneIndices(zone);
	for (var i = 0; i < idx.length; i++) {
		var z = getZoneContainer(idx[i]);
		suspendUpdates = true;
		z.getChild("Tempo BPM").set(bpm);
		z.getChild("Tempo Override").set(true);
		suspendUpdates = false;
		pushZone(idx[i]);
	}
}

function cmdClearTempoOverride(zone) { setOnZones(zone, "Tempo Override", false); }

function cmdSetMasterIntensity(value) {
	var glob = getGlobalContainer();
	if (glob == null) return;
	var p = glob.getChild("Master Intensity");
	if (p != null) p.set(value);         // change handler re-pushes every zone
}

// ============================================================
// Command helpers
// ============================================================
// Zone 0 means "every zone that exists"
function zoneIndices(zone) {
	var result = [];
	var z = toInt(zone);

	if (z == 0) {
		for (var i = 1; i <= MAX_ZONES; i++) if (getZoneContainer(i) != null) result.push(i);
		return result;
	}

	if (getZoneContainer(z) != null) result.push(z);
	else if (warnedMissingZones.indexOf(z) < 0) {
		warnedMissingZones.push(z);
		script.logWarning("Command targets Zone " + toInt(z) + " but only " + toInt(getSetupValue("Zone Count", 0)) + " zone(s) exist. Raise Setup > Zone Count.");
	}
	return result;
}

function setOnZones(zone, paramName, value) {
	var idx = zoneIndices(zone);
	for (var i = 0; i < idx.length; i++) {
		var p = getZoneContainer(idx[i]).getChild(paramName);
		if (p != null) p.set(value);
	}
}

function setDataOnZones(zone, paramName, data) {
	var idx = zoneIndices(zone);
	for (var i = 0; i < idx.length; i++) {
		var p = getZoneContainer(idx[i]).getChild(paramName);
		if (p != null) p.setData(data);
	}
}

function setPoint2DOnZones(zone, paramName, x, y) {
	var idx = zoneIndices(zone);
	for (var i = 0; i < idx.length; i++) {
		var p = getZoneContainer(idx[i]).getChild(paramName);
		if (p != null) p.set(x, y);
	}
}

function setPoint2DAxisOnZones(zone, paramName, axis, value) {
	var idx = zoneIndices(zone);
	for (var i = 0; i < idx.length; i++) {
		var p = getZoneContainer(idx[i]).getChild(paramName);
		if (p == null) continue;
		var current = p.get();
		if (axis == 0) p.set(value, current[1]);
		else p.set(current[0], value);
	}
}

function setFXParam(zone, fx, paramName, value) {
	var slot = clampInt(toInt(fx), 1, NUM_FX);
	var idx = zoneIndices(zone);
	for (var i = 0; i < idx.length; i++) {
		var fxCC = findContainer(getZoneContainer(idx[i]), "FX " + toInt(slot));
		if (fxCC == null) continue;
		var p = fxCC.getChild(paramName);
		if (p != null) p.set(value);
	}
}

// ============================================================
// Tree helpers
// ============================================================
function getSetupContainer() { return findContainer(local.parameters, "Setup"); }
function getGlobalContainer() { return findContainer(local.parameters, "Global"); }
function getZonesContainer() { return findContainer(local.parameters, "Zones"); }

function getSetupValue(name, fallback) { return containerValue(getSetupContainer(), name, fallback); }
function getGlobalValue(name, fallback) { return containerValue(getGlobalContainer(), name, fallback); }

function containerValue(cc, name, fallback) {
	if (cc == null) return fallback;
	var p = cc.getChild(name);
	return p == null ? fallback : p.get();
}

function getZoneContainer(index) {
	var zones = getZonesContainer();
	if (zones == null) return null;
	return findContainer(zones, "Zone " + toInt(index));
}

// Which zone (1-8) does this parameter belong to? Handles FX sub-containers too.
function zoneIndexForParam(param, parent) {
	var zones = getZonesContainer();
	if (zones == null) return -1;

	var grandParent = parent.getParent();
	var list = zones.getContainers();
	for (var i = 0; i < list.length; i++) {
		if (parent.is(list[i]) || (grandParent != null && grandParent.is(list[i]))) return zoneNumberFromName(list[i].niceName);
	}
	return -1;
}

// "Zone 3" -> 3. Note this engine's substring() always takes both bounds -
// substring(5) alone would return an empty string.
function zoneNumberFromName(niceName) {
	return parseInt(niceName.substring(5, niceName.length));
}

// getContainers()/getControllables() instead of getChild() so a miss stays silent
function findContainer(cc, niceName) {
	var list = cc.getContainers();
	for (var i = 0; i < list.length; i++) if (list[i].niceName == niceName) return list[i];
	return null;
}

function findControllable(cc, niceName) {
	var list = cc.getControllables();
	for (var i = 0; i < list.length; i++) if (list[i].niceName == niceName) return list[i];
	return null;
}

function hasControllable(cc, niceName) { return findControllable(cc, niceName) != null; }

// ============================================================
// Parameter creation
// ============================================================
// add*Parameter returns the existing parameter untouched when the name is already
// there, so these are safe to call on every init - saved values are preserved.
// setAttribute("saveValueOnly", false) is what makes a script-created parameter
// save its type/range/options, which is what lets Chataigne recreate the whole
// zone tree when the project is loaded (before this script has even run).
function addBool(cc, name, description, defaultValue) {
	var p = cc.addBoolParameter(name, description, defaultValue);
	p.setAttribute("saveValueOnly", false);
	return p;
}

// Like addFloat below, the range is re-applied on every init rather than only on
// creation: Clip X's ceiling follows Setup > Deck Columns, and add*Parameter hands back
// an existing parameter untouched. setRange only ever clamps a value that was actually
// set - a parameter still on its default is reset to that same default.
function addInt(cc, name, description, defaultValue, minValue, maxValue) {
	var p = cc.addIntParameter(name, description, defaultValue, minValue, maxValue);
	p.setAttribute("saveValueOnly", false);
	p.setRange(minValue, maxValue);
	return p;
}

// The range is script-defined, so it is re-applied on every init rather than only
// on creation: a project saved before a range changed here picks the new one up on
// load, and a saved value outside it gets clamped in. Re-applying an unchanged
// range is a no-op.
function addFloat(cc, name, description, defaultValue, minValue, maxValue) {
	var p = cc.addFloatParameter(name, description, defaultValue, minValue, maxValue);
	p.setAttribute("saveValueOnly", false);
	p.setRange(minValue, maxValue);                     // addFloatParameter casts its range to int
	return p;
}

function addColor(cc, name, description, rgba) {
	var p = cc.addColorParameter(name, description, rgba);
	p.setAttribute("saveValueOnly", false);
	return p;
}

function addPoint2D(cc, name, description, x, y, minValue, maxValue) {
	var isNew = !hasControllable(cc, name);
	var p = cc.addPoint2DParameter(name, description);
	p.setAttribute("saveValueOnly", false);
	p.setRange([minValue, minValue], [maxValue, maxValue]);
	if (isNew) p.set(x, y);                             // only the range is script-owned; the value is the user's
	return p;
}

function addEnum(cc, name, description, keys, datas, preferredKey) {
	var p = cc.addEnumParameter(name, description);
	p.setAttribute("saveValueOnly", false);
	setEnumOptions(p, keys, datas, preferredKey);
	return p;
}

// Options are rebuilt every time so the list always matches this script, while the
// current selection is kept (clearing options resets the value to the first entry).
// Restored by DATA, not by key: the label text is not stable - the Clip labels have
// changed shape twice - while the data behind an option is exactly the thing being
// selected (the clip number, the block size).
function setEnumOptions(p, keys, datas, preferredKey) {
	var hadValue = p.getKey() != "";
	var current = p.get();

	p.removeOptions();
	for (var i = 0; i < keys.length; i++) p.addOption(keys[i], datas == null ? i : datas[i]);

	if (hadValue) p.setData(current);
	else if (preferredKey != "" && keys.indexOf(preferredKey) >= 0) p.set(preferredKey);
}

// ============================================================
// Conversions
// ============================================================
function dmx8FromUnit(v) { return clampInt(Math.round(v * 255), 0, 255); }               // 0..1   -> 0..255
function dmx8FromBipolar(v) { return clampInt(Math.round((v + 1) * 127.5), 0, 255); }    // -1..1  -> 0/128/255
function dmx16FromBipolar(v) { return clampInt(Math.round((v + 1) * 32767.5), 0, 65535); } // -1..1 -> 0/32768/65535

function clampInt(v, mn, mx) { return toInt(Math.max(mn, Math.min(mx, v))); }

// A Math.round()/division result stays Double-typed even when whole, which breaks
// string concatenation ("FX 1.0") and name lookups. Force it back to an int.
function toInt(n) { return parseInt(n); }
