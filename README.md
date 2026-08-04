# Liberation DMX — Chataigne module

> ### ⚠️ Known Liberation bug — FX parameters do nothing
>
> **FX Param 1 and Param 2 are ignored by Liberation's DMX Input** (confirmed on
> Liberation 1.2.0, reported to the developer). Changing the same parameter from
> Liberation's own FX panel visibly changes the beam; driving it over DMX does
> nothing at all.
>
> This is not a module fault — capturing the Art-Net stream shows the parameter
> channels carrying exactly the right values (Param 1 at 0 / 0.25 / 0.75 / 1.0
> puts 0 / 64 / 191 / 255 on channel 18, and the per-slot stride is correct).
> Liberation simply does not act on them.
>
> **FX Level works normally** — at 0 the effect is not applied, raise it and the
> effect renders. Only the two parameter channels per slot are affected. The
> parameters are left in place so they start working the day Liberation fixes it.

Controls [Liberation](https://www.liberationlaser.com) through its **DMX Input**
system over **Art-Net**, instead of MIDI. Up to **8 zones**, each one mapped to a
single Liberation DMX Input profile row.

Liberation's raw DMX quirks are hidden: clips are picked from **Page + Clip
dropdowns** instead of Gobo Bank / Gobo Select values, position is a normalized
`-1..1` Point2D written across the **16-bit coarse + fine** channel pairs, and
channel addressing is assigned automatically.

This is a companion to the MIDI-based Liberation module, not a replacement — DMX
Input drives a *separate render pass* per zone, with its own transforms. See
`CHANNEL_MAP.md` for the wire-level detail.

## Files

- `module.json` — module definition (setup parameters + commands)
- `liberationDMX.js` — builds the zone tree, encodes channels, sends DMX
- `CHANNEL_MAP.md` — channel table, value conversions, clip-slot maths
- `README.md` — this file
- `icon.png` — 32×32 module icon
- `LICENSE` — GNU GPL v3
- `.gitignore` — keeps Chataigne working files out of the repo

## Install

**Chataigne**

1. Copy the `chataigne-liberation-dmx` folder into `Documents/Chataigne/modules/`
   (or into a `modules/` folder next to your `.noisette` for a project-local module).
2. **File > Reload custom modules**, or restart Chataigne.
3. Add **Liberation DMX** from the module list (under *Software*).

**Liberation**

1. Open the **DMX Input** window.
2. Add one profile row per zone: pick the Liberation zone, the profile type
   (**Extended 32ch** unless you changed it), the universe and the start address.
3. Match the numbers Chataigne prints when you hit **Setup > Log Addressing**.

## Setup parameters

| Parameter | What it does |
|---|---|
| **Zone Count** | 0–8. Creates/removes `Zones > Zone N` containers. |
| **New Zone Profile** | Profile given to newly created zones (`Extended 32ch` default). Each zone can be changed afterwards. |
| **Auto Address** | On: zones are stacked automatically from Base Universe/Address using each zone's size (16 or 32 ch), spilling into the next universe if a block would cross 512. Off: Universe and Start Address become editable per zone. |
| **Base Universe** / **Base Address** | Where the first zone starts. Universe numbering is Liberation's 1-based UI numbering. |
| **Rebuild Zones** | Rebuilds the tree, re-sends everything, re-runs the sanity checks. Also the recovery button if anything ever looks stuck. |
| **Log Addressing** | Prints each zone's universe / channel range / profile to the log, ready to copy into Liberation. |

## Global options

So a trigger or mapping can just set a clip and have it show, without also sending
Arm and Intensity every time.

| Parameter | Default | What it does |
|---|---|---|
| **Arm Follows Clip** | on | Selecting a clip arms that zone; selecting `None` disarms it. ⚠️ With this on, choosing a clip **immediately enables laser output** for the zone. Turn it off to drive Arm yourself. |
| **Intensity Follows Clip** | on | Selecting a clip also sets that zone's Intensity to full, so a clip never lands on a zone someone left dimmed. |
| **Master Intensity** | 1.0 | Grand master: scales every zone's Intensity on the way out. It does not overwrite the per-zone values, so pulling it down and back up restores the look. Also available as the **Set Master Intensity** command for mappings. |

With the defaults, `Select Clip` on its own is enough to put light in the air — and
`Clear Clip` is a real blackout again.

The module presets the DMX side for you: **DMX Type = Art-Net**, Send Rate 44 Hz,
Send On Change Only off. Set **Remote Host** (under the ArtNet device parameters)
if Liberation is on another machine — it defaults to `127.0.0.1`.

Note there are *two* Send Rate parameters, which is Chataigne's design, not this
module's: the **module's** (how often the universe buffers are handed to the device)
and the **Art-Net device's**, under `Art-Net > Output` (how often the device flushes
what it was handed). The device's stock default is 44 Hz — the DMX512 frame ceiling —
so this module sets its own to 44 as well rather than leaving the two at different
rates. Either way both are far inside Liberation's 2-second staleness window.

## Per-zone parameters

Each `Zones > Zone N` container holds the live state; changing anything writes the
whole block immediately.

| Parameter | Range | Notes |
|---|---|---|
| Enabled | bool | Off forces Arm to 0 — the zone keeps streaming but stops rendering. |
| Profile | enum | Must match the profile chosen for that zone in Liberation. |
| Universe / Start Address | int | Read-only while Auto Address is on. |
| Arm | bool | On = 255. Liberation only renders with Arm ≥ 250. Set for you when **Arm Follows Clip** is on. |
| Intensity | 0..1 | 0–100% brightness, scaled by **Master Intensity** on the way out. |
| Page | enum | Clip deck page (Gobo Bank). |
| Clip | enum | `None (no clip)` or `Col C - Row R`, in the deck's own fill order. |
| Colour | RGBA | Desk RGB. Alpha ignored — use Intensity. |
| Colour Blend | 0..1 | 0 = clip's own colour, 1 = desk RGB. |
| Zoom | 0..1 | 0 = collapsed, 1 = normal size. |
| Position | Point2D −1..1 | (0,0) = centre, **+X right, +Y down**. 16-bit. |
| Scale | Point2D −1..1 | −1 = −100% (mirrors the clip on that axis), 0 = 0% neutral (default), 1 = +100%. |
| Rotation | −1..1 | Spin: −1 = max CCW, 0 = stopped, 1 = max CW. |
| Tempo Override / Tempo BPM | bool + 1..255 | Extended profile only. Off = follow Liberation's tempo. |
| FX 1–4 > Level, Param 1, Param 2 | 0..1 | Extended profile only. Param 1 / Param 2 are currently ignored by Liberation — see the warning at the top. |

Because these are module *parameters*, they are also reachable over
OSC/OSCQuery, savable with the project, and editable by hand from the module panel.

## Commands (for Mappings, Sequences, Actions)

Every command takes a **Zone** number, where **0 means "all zones"**. The parameter
marked below with `*` is the one a Mapping feeds.

- **Zone** — Set Arm `*`, Set Intensity `*`, Set Enabled `*`, Blackout Zone, Reset Zone
- **Clip** — Select Clip (Page + Clip), Set Page, Set Clip, Clear Clip
- **Colour** — Set Colour `*` (a colour mapping feeds RGBA directly), Set Colour Blend `*`
- **Transform** — Set Position `*` (2D mapping → X/Y), Set Position X `*`, Set Position Y `*`, Set Scale `*`, Set Scale X `*`, Set Scale Y `*`, Set Zoom `*`, Set Rotation `*`
- **Effects** — Set FX Level `*`, Set FX Parameter `*` (ignored by Liberation, see the warning at the top), Clear Effects
- **Tempo** — Set Tempo Override `*` (BPM; also switches the override on), Clear Tempo Override
- **Global** — Set Master Intensity `*` (grand master across all zones)

Commands write the zone's parameters, so the module panel always shows what was
last sent.

## Things worth knowing

**Nothing goes out until a zone is armed.** Liberation renders the DMX pass only
when the profile is active, Arm ≥ 250, a clip is selected, and Intensity > 0. A
silent rig is almost always Arm off or Clip = None — which is what **Arm Follows
Clip** and **Intensity Follows Clip** above exist to take care of.

**Staleness is handled for you.** Liberation drops a zone after 2 s without fresh
data; Chataigne's DMX module hands every output universe to the device continuously at
Send Rate. Don't switch **Send On Change Only** on (it is hidden and defaulted off for
exactly this reason) — the device only emits what the module hands it, so with that
option on a settled universe stops being sent at all and Liberation goes stale.

**Turning things off disarms the laser.** Because the universe is re-sent
continuously, a zone that simply disappeared from the module would otherwise keep
streaming its last state — including `Arm` at 255 — with nothing left in the UI to
switch it off. So the channels a zone owned are actively blanked when it goes away:
lowering **Zone Count**, switching a zone from Extended to Basic (releasing ch 17–32),
and re-addressing a zone to a different universe or start address all zero the
channels being vacated before anything else is written. Turning the **module** off,
deleting it, or closing the project needs no such handling — output stops entirely and
Liberation disarms the zone on its own 2-second timeout.

**After loading a project, the first push happens on the first change.** A module
script's `init()` runs when Chataigne *creates* the module — before a saved project
restores its Output Universes — so the opening push can land nowhere. The module
notices this and re-sends every zone on the next parameter change, including the
ones the project itself restores while loading, so in practice it heals during the
load. To force it, hit **Rebuild Zones**; it's OSC-addressable and usable as an
Action, so you can fire it from a startup State if you want a guarantee.

**Universes must exist in the module.** Chataigne only transmits universes listed
under *Module Parameters > Output Universes*, and a script cannot create them. The
module ships with one (net 0 / subnet 0 / universe 0 = Liberation universe **1**),
so single-universe setups work untouched. If a zone points somewhere else, the log
says exactly which universe to add. Hit **Rebuild Zones** after adding it.

**Universe numbering.** Zone `Universe` is Liberation's 1-based UI number.
Universe 1 = Art-Net Port-Address 0 = Chataigne net 0 / subnet 0 / universe 0. The
1–4096 range is exactly what Art-Net addressing reaches through Chataigne, whose
per-universe `Net` field stops at 15.

**Art-Net only.** Liberation's DMX Input also speaks sACN, but this module does not:
it addresses universes the Art-Net way, as net / subnet / universe. Leave **DMX Type**
on `Art-Net` — pointing the module at an sACN device makes it target universes that do
not match the ones Chataigne would send, and nothing goes out.

**Basic 16ch zones** ignore the FX and Tempo parameters — those channels simply
aren't transmitted. The parameters stay in the tree so switching profiles doesn't
lose their values.

**Scale is bipolar and negatives mirror.** Ch 10/11 run −100% / 0% / +100% across
DMX 0 / 128 / 255, so `Scale` is a −1..1 Point2D passed straight through. Negative
values mirror the clip on that axis — that is Liberation working as intended, not a
glitch. The parameter defaults to **0** (DMX 128, neutral), so a fresh zone renders
the clip as authored.

**FX Param 1 / Param 2 currently do nothing** — see the warning at the top. The
channels are transmitted correctly; Liberation ignores them. **FX Level** is
unaffected and works as documented: it is the effect *amount*, and it defaults to
0, so nothing renders from a slot until you raise it.

**FX parameter neutral value** is 0.5 (DMX 128), per the profile's recommended
defaults.

## Verifying without a laser

Everything on the wire is plain Art-Net, so any Art-Net monitor (or a second
Chataigne DMX module with input enabled on port 6454) will show the block. Arm a
zone, watch channel 1 go to 255, pick a clip and watch the Gobo Select channel
land in the middle of that slot's band.

## License

Released under the **GNU General Public License v3** — see `LICENSE`.

`icon.png` is Liberation's own logo mark, used to identify the software this
module talks to. It remains the property of its owners and is not covered by the
GPL grant above.

## More information

- [Liberation — next gen laser software](https://www.liberationlaser.com)
- [Liberation user manual](https://docs.liberationlaser.com)
- [Chataigne](https://benjamin.kuperberg.fr/chataigne/en)
- [Chataigne module documentation](https://benkuperberg.gitbook.io/chataigne-docs/modules/custom-modules/making-your-own-module)
