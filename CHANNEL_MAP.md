# Liberation DMX Input — channel map and conversions

What this module puts on the wire, and how each Chataigne parameter becomes DMX.
Source of truth for the profiles is Liberation's own *DMX Input Fixture Profiles*
doc; this file records the encoding decisions made on the Chataigne side.

## Block layout

One zone = one consecutive block: **16 channels** (Basic 16ch) or **32 channels**
(Extended 32ch), starting at the zone's Start Address inside the zone's universe.
Channel numbers below are offsets *within* the block.

| Ch | Name | Liberation default | Chataigne parameter | Conversion |
|---|---|---|---|---|
| 1 | Arm | 0 | `Arm` (+ `Enabled`) | `Enabled && Arm ? 255 : 0`. Liberation enables output at 250–255. |
| 2 | Intensity | 255 | `Intensity` 0..1 | `round(v * 255)` |
| 3 | Gobo Bank | 0 | `Page` enum | page index 0–7 sent directly |
| 4 | Gobo Select | 0 | `Clip` enum | slot → mid-band value, see below |
| 5 | Red | 255 | `Colour` R | `round(r * 255)` |
| 6 | Green | 255 | `Colour` G | `round(g * 255)` |
| 7 | Blue | 255 | `Colour` B | `round(b * 255)` |
| 8 | Colour Blend | 255 | `Colour Blend` 0..1 | `round(v * 255)` — 0 = clip colour, 255 = desk RGB |
| 9 | Zoom | 255 | `Zoom` 0..1 | `round(v * 255)` — 0 = collapsed, 255 = normal |
| 10 | Scale X | 255 | `Scale.x` −1..1 | `round((v + 1) * 127.5)` → 0 / 128 / 255 |
| 11 | Scale Y | 255 | `Scale.y` −1..1 | same |
| 12 | Position X coarse | 128 | `Position.x` −1..1 | 16-bit, high byte |
| 13 | Position X fine | 0 | `Position.x` | 16-bit, low byte |
| 14 | Position Y coarse | 128 | `Position.y` −1..1 | 16-bit, high byte |
| 15 | Position Y fine | 0 | `Position.y` | 16-bit, low byte |
| 16 | Rotation | 128 | `Rotation` −1..1 | `round((v + 1) * 127.5)` — 128 = stopped |
| 17 | FX 1 Level | 0 | `FX 1 > Level` 0..1 | `round(v * 255)` |
| 18 | FX 1 Parameter 1 | 128 | `FX 1 > Param 1` 0..1 | `round(v * 255)`, 0.5 → 128 |
| 19 | FX 1 Parameter 2 | 128 | `FX 1 > Param 2` 0..1 | same |
| 20–22 | FX 2 Level / P1 / P2 | 0 / 128 / 128 | `FX 2 > …` | same |
| 23–25 | FX 3 Level / P1 / P2 | 0 / 128 / 128 | `FX 3 > …` | same |
| 26–28 | FX 4 Level / P1 / P2 | 0 / 128 / 128 | `FX 4 > …` | same |
| 29 | Reserved 1 | 0 | — | always 0 |
| 30 | Reserved 2 | 0 | — | always 0 |
| 31 | Tempo override coarse | 0 | `Tempo Override` + `Tempo BPM` | 0 = follow Liberation, else `floor(bpm)` clamped 1–255 |
| 32 | Tempo override fine | 0 | `Tempo BPM` | `round(frac(bpm) * 256)`, only meaningful when ch 31 > 0 |

Channels 17–32 are only transmitted for **Extended 32ch** zones; a Basic 16ch zone
sends a 16-channel block and its FX/Tempo parameters are ignored.

## Position — 16-bit, both bytes native

Liberation decodes the coarse/fine pair as one 16-bit value: `0 → -200`,
`32768 ≈ centre`, `65535 → +200`, with **+X right and +Y down**.

```
v16   = round((n + 1) * 32767.5)      // n = -1..1  ->  0..65535
coarse = (v16 >> 8) & 255
fine   =  v16       & 255
```

`n = -1 → 0`, `n = 0 → 32768` (centre), `n = +1 → 65535`. Full 16-bit resolution,
i.e. 65536 steps — the fine byte is always written, never left at 0.

The `Position` parameter is deliberately **not** Y-flipped: it uses Liberation's
own convention so what you send matches the doc.

## Scale — bipolar size, negatives mirror

Ch 10/11 are bipolar exactly as the profile doc describes: `0 = -100%`,
`128 = 0%`, `255 = +100%`, and the parameter passes that through directly:

```
scaleDMX = round((v + 1) * 127.5)      // v = -1..1  ->  0 / 128 / 255
```

Those percentages are a **size**, not a delta. Liberation decodes the channel as
roughly `(dmx - 128) / 127` and scales the clip by it, so DMX 255 is the clip at its
authored size, DMX 128 collapses it to nothing, and DMX 0 is full size mirrored on
that axis. That is why the profile's default for both channels is **255** — the same
"leave it alone" role that 128 plays for Position coarse and Rotation — and why
`Scale` defaults to **1** here.

Negative values mirror the clip rather than shrinking past nothing: -1 is the same
size as +1, flipped.

Verified against Liberation 1.2.1: 1.0 → 255 → Live Monitor `Sc: 100%` and the clip
at authored size; 0.5 → 191 → `Sc: 49%` and visibly half; 0 → 128 → nothing on the
canvas; -1 → 0 → full size, flipped on both axes.

Liberation 1.2.0 decoded the channel into the same Live Monitor percentages but never
applied it to the render, so a zone drew at authored size whatever the value was.
Anything built against that behaviour — including this module before 1.5.0, which
defaulted `Scale` to 0 — now renders nothing until Scale is raised to 1.

## Clips — hiding Gobo Bank / Gobo Select

Liberation treats the clip deck like a gobo wheel:

- **Gobo Bank** is a direct page index. One bank = one 8 × 5 deck page = 40 slots.
- **Gobo Select** 0 = no clip. 1–255 is divided across the 40 slots:

```
slot   = 1 + floor((goboSelect - 1) * 40 / 255)      clamped to 1..40
gridX  = (goboBank * 8) + floor((slot - 1) / 5)
gridY  = (slot - 1) % 5
```

Slots fill **down the 5 rows of a column, then move to the next column** — which is
why the module labels them `Col C - Row R` rather than X/Y. Slot number for a
label is `(C - 1) * 5 + R`.

Going the other way (what this module does), each slot owns a band of ~6.375 DMX
steps, so it aims at the **middle** of the band. Rounding to a band edge would land
on the neighbouring clip:

```
goboSelect = 1 + round((2 * slot - 1) * 255 / 80)     // clamped 1..255
```

Slot 1 → 4, slot 20 → 125, slot 40 → 253. Feeding those back through Liberation's
formula returns 1, 20 and 40.

`Clip = None (no clip)` sends Gobo Select 0, which is Liberation's blackout.

## Universe addressing

Zone `Universe` is Liberation's **1-based UI** number. Art-Net Port-Address is
0-based, and Chataigne splits that into net / subnet / universe:

```
portAddress = universe - 1
net      = (portAddress >> 8) & 0x7F
subnet   = (portAddress >> 4) & 0x0F
universe = (portAddress     ) & 0x0F
```

So Liberation universe **1** = Art-Net Port-Address **0** = Chataigne
net 0 / subnet 0 / universe 0, which is the output universe a fresh DMX module
already has. The 1–4096 range is the whole of what this reaches: Chataigne's
per-universe `Net` field stops at 15, and 4096 lands exactly on net 15.

This split is **Art-Net-specific**, which is why the module is Art-Net only. Under
sACN Chataigne matches universes on the raw 1-based universe number with net and
subnet unused, so the same zone would resolve to a universe that does not exist and
nothing would be transmitted.

Auto Address stacks zones by profile size and starts a new universe rather than
letting a block cross channel 512.

## Refresh behaviour

The script only writes values into the universe buffer. Two threads then keep the
wire busy, which is what stops Liberation's 2-second staleness timer expiring:

- the **module's** send thread hands every output universe to the device at the
  module's **Send Rate**;
- the **Art-Net device's** sender thread flushes whatever it was handed since the last
  tick, at the device's own **Send Rate**, a separate parameter under `Art-Net > Output`.

Both default to 44 Hz — Chataigne's stock value for the device, and what this
module sets its own to so the two stages run at the same rate.

No heartbeat logic exists here, and none is needed — but **Send On Change Only must
stay off**, which is why the module hides it and defaults it to false. The device is a
queue drain, not a repeater: with that option on, a universe whose channels have
settled stops being handed over, so nothing is emitted and Liberation goes stale.

## Releasing channels

The flip side of a universe that is re-sent forever is that channels have to be given
back explicitly. `Arm` is the first channel of a block, so a block left behind is a
zone left rendering. The script remembers the `[universe, start, size]` of every block
it sends, and zeroes any block that stops being covered:

- **Zone Count lowered** — the removed zones' blocks are zeroed.
- **Extended → Basic** — ch 17–32 are zeroed as the block shrinks.
- **Universe or Start Address changed** — the old block is zeroed before the new one is
  written.

All releases for a re-address happen *before* any block is written, so a zone that
shifted down cannot be blanked by the neighbour vacating the channels it just moved
into.

Losing the module entirely — disabled, deleted, project closed — needs no release:
Chataigne's send thread stops, so Liberation disarms the zone on its own 2-second
staleness timeout.
