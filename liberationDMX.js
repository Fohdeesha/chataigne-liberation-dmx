// Liberation DMX - Chataigne custom module script
//
// Streams Liberation's "DMX Input" fixture profiles (Basic 16ch / Extended 32ch)
// out of Chataigne's DMX module. One Chataigne zone == one Liberation DMX Input
// profile row == one consecutive block of channels in one universe.
//
// Nothing here polls or re-sends on a timer: the DMX module's own send thread
// re-transmits every output universe at "Send Rate" (40 Hz by default), so the
// channel values written here keep flowing and Liberation never sees the input
// go stale (it disables a zone after 2 s without fresh data).
//
// See CHANNEL_MAP.md for the channel table and the value conversions.

// ============================================================
// Constants
// ============================================================
var MAX_ZONES = 8;

var DECK_COLS = 8;                 // clip deck columns per page
var DECK_ROWS = 5;                 // clip deck rows per page
var SLOTS_PER_PAGE = 40;           // DECK_COLS * DECK_ROWS
var NUM_PAGES = 8;
var NUM_FX = 4;

var PROFILE_EXTENDED = "extended32";
var PROFILE_BASIC = "basic16";
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
var PAGE_KEYS = [];                // index = bank (0-based)
var CLIP_KEYS = [];                // index = slot (0 = no clip)
var warnedMissingZones = [];       // zone numbers already warned about, cleared on rebuild

// ============================================================
// Entry points
// ============================================================
function init() {
	suspendUpdates = false;                // recover if a previous run died mid-update
	buildLookupTables();
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

	if (suspendUpdates || !ready) return;

	var zoneIndex = zoneIndexForParam(param, parent);
	if (zoneIndex <= 0) return;

	var name = param.niceName;
	if (name == "Profile" || name == "Universe" || name == "Start Address") {
		// block size or placement changed - re-stack everything, then re-send all zones
		applyAddressing();
		pushAllZones();
		return;
	}

	pushZone(zoneIndex);
}

function setupParameterChanged(name) {
	if (name == "Zone Count" || name == "New Zone Profile") {
		rebuildZones();
	} else if (name == "Auto Address" || name == "Base Universe" || name == "Base Address") {
		applyAddressing();
		pushAllZones();
	} else if (name == "Rebuild Zones") {
		rebuildZones();
	} else if (name == "Log Addressing") {
		logAddressing();
	}
}

// ============================================================
// Lookup tables (Page / Clip dropdowns)
// ============================================================
// Liberation's own slot order: fill down the 5 rows of a column, then move to
// the next column. Slot n therefore sits at deck position
//   gridX = bank * 8 + floor((n - 1) / 5),  gridY = (n - 1) % 5
function buildLookupTables() {
	PAGE_KEYS = [];
	for (var p = 0; p < NUM_PAGES; p++) PAGE_KEYS.push("Page " + toInt(p + 1));

	CLIP_KEYS = [];
	CLIP_KEYS.push(CLIP_NONE_KEY);                       // index 0 = no clip / blackout
	for (var c = 1; c <= DECK_COLS; c++) {
		for (var r = 1; r <= DECK_ROWS; r++) CLIP_KEYS.push("Col " + toInt(c) + " - Row " + toInt(r));
	}
}

function bankFromPageKey(key) {
	var i = PAGE_KEYS.indexOf(key);
	return i < 0 ? 0 : i;
}

function slotFromClipKey(key) {
	var i = CLIP_KEYS.indexOf(key);
	return i < 0 ? 0 : i;
}

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
	addEnum(z, "Profile", "Which Liberation DMX Input profile this zone uses. Must match the profile chosen for this zone in Liberation.", [PROFILE_EXTENDED_KEY, PROFILE_BASIC_KEY], [PROFILE_EXTENDED, PROFILE_BASIC], isNewZone ? newZoneProfileKey() : "");
	addInt(z, "Universe", "Universe in Liberation's 1-based UI numbering (1 = Art-Net Port-Address 0). Managed automatically unless Setup > Auto Address is off.", 1, 1, 4096);
	addInt(z, "Start Address", "First channel of this zone's block (1-512). Managed automatically unless Setup > Auto Address is off.", 1, 1, 512);

	// --- live control ---
	addBool(z, "Arm", "Arm channel. Liberation only renders this zone's DMX layer when Arm is at least 250, a clip is selected and Intensity is above zero.", false);
	addFloat(z, "Intensity", "0-1 mapped to 0-100% brightness.", 1, 0, 1);
	addEnum(z, "Page", "Clip deck page (Gobo Bank). Each page is one 8 x 5 deck of clips.", PAGE_KEYS, null, "");
	addEnum(z, "Clip", "Clip slot on the selected page (Gobo Select). 'None' = no clip / blackout.", CLIP_KEYS, null, "");
	addColor(z, "Colour", "Desk RGB colour. Alpha is ignored - use Intensity for brightness.", [1, 1, 1, 1]);
	addFloat(z, "Colour Blend", "0 = the clip's own colour, 1 = the desk RGB colour above.", 1, 0, 1);
	addFloat(z, "Zoom", "0 = collapsed, 1 = normal size.", 1, 0, 1);
	addPoint2D(z, "Position", "-1..1 on each axis, (0,0) = centre. +X right, +Y DOWN (Liberation's convention). Sent 16-bit over the coarse + fine channel pairs.", 0, 0, -1, 1);
	addPoint2D(z, "Scale", "-1 = -100%, 0 = 0%, 1 = +100% on each axis (DMX 0 / 128 / 255).", 1, 1, -1, 1);
	addFloat(z, "Rotation", "Spin: -1 = max counter-clockwise, 0 = stopped, 1 = max clockwise.", 0, -1, 1);
	addBool(z, "Tempo Override", "Extended 32ch only. Off = follow Liberation's tempo. On = drive this zone from Tempo BPM below.", false);
	addFloat(z, "Tempo BPM", "Extended 32ch only. Only sent while Tempo Override is on. Coarse BPM plus a 1/256 fine part.", 120, 1, 255);

	for (var f = 1; f <= NUM_FX; f++) {
		var fxName = "FX " + toInt(f);
		var isNewFX = findContainer(z, fxName) == null;
		var fx = z.addContainer(fxName);
		if (isNewFX) fx.setCollapsed(true);
		addFloat(fx, "Level", "Extended 32ch only. Effect depth / amount for this slot.", 0, 0, 1);
		addFloat(fx, "Param 1", "Extended 32ch only. First exposed parameter of this effect. 0.5 is the recommended neutral value (DMX 128).", 0.5, 0, 1);
		addFloat(fx, "Param 2", "Extended 32ch only. Second exposed parameter of this effect. 0.5 is the recommended neutral value (DMX 128).", 0.5, 0, 1);
	}

	return z;
}

function newZoneProfileKey() {
	var v = getSetupValue("New Zone Profile", PROFILE_EXTENDED);
	return v == PROFILE_BASIC_KEY || v == PROFILE_BASIC ? PROFILE_BASIC_KEY : PROFILE_EXTENDED_KEY;
}

function zoneProfileSize(z) {
	var p = z.getChild("Profile");
	if (p == null) return 32;
	return p.get() == PROFILE_BASIC_KEY ? 16 : 32;
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

function validateAddressing() {
	var used = [];                                  // "universe:channel" strings already claimed
	var missingUniverses = [];

	for (var i = 1; i <= MAX_ZONES; i++) {
		var z = getZoneContainer(i);
		if (z == null) continue;

		var size = zoneProfileSize(z);
		var universe = toInt(z.getChild("Universe").get());
		var start = toInt(z.getChild("Start Address").get());

		if (start + size - 1 > 512) {
			script.logWarning("Zone " + toInt(i) + " needs channels " + toInt(start) + "-" + toInt(start + size - 1) + " but a universe only has 512. Lower its Start Address or move it to another universe.");
		}

		for (var c = start; c < start + size && c <= 512; c++) {
			var key = toInt(universe) + ":" + toInt(c);
			if (used.indexOf(key) >= 0) {
				script.logWarning("Zone " + toInt(i) + " overlaps another zone at universe " + toInt(universe) + ", channel " + toInt(c) + ". Liberation will see both zones fighting over the same channels.");
				break;
			}
			used.push(key);
		}

		if (!outputUniverseExists(universe) && missingUniverses.indexOf(universe) < 0) {
			missingUniverses.push(universe);
			script.logWarning("Zone " + toInt(i) + " targets universe " + toInt(universe) + " (Art-Net " + artnetSignatureString(universe) + ") but the module has no matching Output Universe, so nothing will be sent. Add it under Module Parameters > Output Universes.");
		}
	}
}

function logAddressing() {
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
	for (var i = 1; i <= MAX_ZONES; i++) pushZone(i);
}

function pushZone(index) {
	if (suspendUpdates) return;

	var z = getZoneContainer(index);
	if (z == null) return;

	var size = zoneProfileSize(z);
	var start = clampInt(toInt(z.getChild("Start Address").get()), 1, 512);
	if (start + size - 1 > 512) return;              // already warned in validateAddressing()

	var universe = toInt(z.getChild("Universe").get());
	local.sendUniverse(universeNet(universe), universeSubnet(universe), universeUniverse(universe), start, buildZoneBytes(z, size));
}

function buildZoneBytes(z, size) {
	var b = [];
	for (var i = 0; i < size; i++) b.push(0);

	var enabled = z.getChild("Enabled").get();
	var armed = z.getChild("Arm").get();

	// Arm: Liberation enables output at 250-255, disables below
	b[CH_ARM - 1] = (enabled && armed) ? 255 : 0;
	b[CH_INTENSITY - 1] = dmx8FromUnit(z.getChild("Intensity").get());

	var slot = slotFromClipKey(z.getChild("Clip").get());
	b[CH_GOBO_BANK - 1] = clampInt(bankFromPageKey(z.getChild("Page").get()), 0, 255);
	b[CH_GOBO_SELECT - 1] = goboValueForSlot(slot);

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
		z.getChild("Page").set(PAGE_KEYS[0]);
		z.getChild("Clip").set(CLIP_NONE_KEY);
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

function cmdSelectClip(zone, pageKey, clipKey) {
	var idx = zoneIndices(zone);
	for (var i = 0; i < idx.length; i++) {
		var z = getZoneContainer(idx[i]);
		suspendUpdates = true;
		z.getChild("Page").set(pageKey);
		z.getChild("Clip").set(clipKey);
		suspendUpdates = false;
		pushZone(idx[i]);
	}
}

function cmdSetPage(zone, pageKey) { setOnZones(zone, "Page", pageKey); }
function cmdSetClip(zone, clipKey) { setOnZones(zone, "Clip", clipKey); }
function cmdClearClip(zone) { setOnZones(zone, "Clip", CLIP_NONE_KEY); }

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
function getZonesContainer() { return findContainer(local.parameters, "Zones"); }

function getSetupValue(name, fallback) {
	var setup = getSetupContainer();
	if (setup == null) return fallback;
	var p = setup.getChild(name);
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

function hasControllable(cc, niceName) {
	var list = cc.getControllables();
	for (var i = 0; i < list.length; i++) if (list[i].niceName == niceName) return true;
	return false;
}

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

function addInt(cc, name, description, defaultValue, minValue, maxValue) {
	var p = cc.addIntParameter(name, description, defaultValue, minValue, maxValue);
	p.setAttribute("saveValueOnly", false);
	return p;
}

function addFloat(cc, name, description, defaultValue, minValue, maxValue) {
	var isNew = !hasControllable(cc, name);
	var p = cc.addFloatParameter(name, description, defaultValue, minValue, maxValue);
	p.setAttribute("saveValueOnly", false);
	if (isNew) p.setRange(minValue, maxValue);          // addFloatParameter casts its range to int
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
	if (isNew) {
		p.setRange([minValue, minValue], [maxValue, maxValue]);
		p.set(x, y);
	}
	return p;
}

// Options are rebuilt every time so the list always matches this script, while the
// current selection is kept (clearing options resets the value to the first entry).
function addEnum(cc, name, description, keys, datas, preferredKey) {
	var p = cc.addEnumParameter(name, description);
	p.setAttribute("saveValueOnly", false);

	var current = p.getKey();
	p.removeOptions();
	for (var i = 0; i < keys.length; i++) p.addOption(keys[i], datas == null ? i : datas[i]);

	if (keys.indexOf(current) >= 0) p.set(current);
	else if (preferredKey != "" && keys.indexOf(preferredKey) >= 0) p.set(preferredKey);

	return p;
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
