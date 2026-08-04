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
| 10 | Scale X | 255 | `Scale.x` 0..1 | `128 + round(v * 127)` → 128 / 255, see below |
| 11 | Scale Y | 255 | `Scale.y` 0..1 | same |
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

> **FX Parameter channels are ignored by Liberation** (18, 19, 21, 22, 24, 25, 27,
> 28) as of Liberation 1.2.0 — a bug reported to the developer, not a mapping
> error. Captured off the wire, Param 1 at 0 / 0.25 / 0.75 / 1.0 puts 0 / 64 / 191
> / 255 on channel 18 and the per-slot stride of 3 is correct; Liberation just does
> not act on them. The FX **Level** channels (17, 20, 23, 26) work normally.

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

## Scale — top half of the channel only

The profile doc calls ch 10/11 bipolar: `0 = -100%`, `128 = 0%`, `255 = +100%`.
In practice Liberation only renders the **upper** half sanely — anything below 128
produces broken geometry, not a mirrored or shrunken clip. So `Scale` is a plain
**0..1** parameter and the channel never leaves 128..255:

```
scaleDMX = 128 + round(v * 127)        // v = 0..1  ->  128..255
```

`0 → 128` (0%, collapsed), `1 → 255` (100%, normal size — and Liberation's own
recommended default). Liberation reads it back as `(dmx - 128) / 127`, so the
readout in its Live Monitor matches the Chataigne value to within one DMX step
(0.100 → 141 → 10%; 0.200 → 153 → 19%).

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
already has. sACN numbering starts at 1 and lines up with the UI number directly.

Auto Address stacks zones by profile size and starts a new universe rather than
letting a block cross channel 512.

## Refresh behaviour

The script only writes values into the universe buffer. Two threads then keep the
wire busy, which is what stops Liberation's 2-second staleness timer expiring:

- the **module's** send thread hands every output universe to the device at the
  module's **Send Rate**;
- the **Art-Net device's** sender thread emits the packets at the device's own
  **Send Rate**, a separate parameter under `Art-Net > Output`.

Both default to 44 Hz — Chataigne's stock value for the device, and what this
module sets its own to so the two stages run at the same rate.

No heartbeat logic exists here, and none is needed — but **Send On Change Only must
stay off**, which is why the module hides it and defaults it to false.
