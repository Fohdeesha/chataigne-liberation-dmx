# Liberation DMX for Chataigne

Chataigne module that drives [Liberation](https://www.liberationlaser.com) laser
software over Art-Net using its **DMX Input** system. Up to **8 zones**, each one
mapped to a Liberation DMX Input profile row (Basic 16ch or Extended 32ch).

You never deal with the raw DMX. Clips are picked by **Liberation's own clip number**
rather than Gobo Bank / Gobo Select values, position is a normalized `-1..1` Point2D
written to the 16-bit coarse/fine channel pairs, and channel addressing is handled for
you. See [CHANNEL_MAP.md](CHANNEL_MAP.md) for the wire-level detail.

Written against **Liberation 1.2.1 Build 96**. ⚠️ The build number matters:
**1.2.1 Build 95 and older** accept the FX Param and Scale channels but ignore them.

## Install

**Chataigne**: copy this folder into `Documents/Chataigne/modules/`, hit
**File > Reload custom modules**, then add **Liberation DMX** from the module list
(under *Software*). Here's a zone armed on clip `21-1` — the **Clip** dropdown and the
**Clip X** / **Clip Y** boxes are the same selection seen two ways:

![Liberation DMX module in Chataigne](docs/chataigne-module.png)

**Liberation**: open **View > DMX Input Settings** and add one profile row per
zone: the Liberation zone, the profile type (**Extended 32ch** unless you changed
it), the universe and the start address. **Setup > Log Addressing** in Chataigne
prints exactly what to enter here.

![Liberation's DMX Input Settings window](docs/liberation-dmx-input.png)

## Using it

Set **Zone Count**, then drive each `Zones > Zone N` container: Arm, Intensity,
Clip, Colour, Position, Scale, Rotation, Zoom, plus FX and Tempo on the Extended
profile. All of it is also exposed as Commands for Mappings and Sequences (the
**Zone** parameter accepts **0** for all zones) and over OSC/OSCQuery.

### Finding a clip

Right-click any clip in Liberation and its settings header reads **CLIP SETTINGS 21 1** —
the clip's position on the deck, `x` counting columns across every page and `y` the row,
both from 0. The module speaks the same numbers, so there is nothing to convert:

- the **Clip** dropdown lists the whole deck by that number, `21-1`, so it is read in the
  same figures Liberation shows;
- **Clip X** and **Clip Y** take the pair typed straight in. `-1` means no clip. The
  **Select Clip Number** command does the same from a Mapping or Sequence.

Pick from the dropdown and Clip X / Clip Y follow — the two are always the same selection
seen two ways.

There is no page or bank to choose. Liberation's DMX Input addresses clips as a page plus
a slot within it, but both fall out of the clip number, so the module works them out on
the way to the wire. Set **Setup > Deck Columns** to roughly how wide your deck is and
the Clip list covers it; the default of 96 clears Liberation's own 89-column factory
project.

With the default options, selecting a clip is enough to put light in the air.
**Arm Follows Clip** and **Intensity Follows Clip** arm the zone and raise its
Intensity on every clip change, and selecting `None` disarms it again. ⚠️ This
means choosing a clip immediately enables laser output for that zone. Switch both
options off if you want to drive Arm yourself. **Master Intensity** scales every
zone on the way out without touching the per-zone values.

**Auto Address** stacks zones automatically from Base Universe/Address, spilling
into the next universe when a block would cross channel 512. Turn it off to set
Universe and Start Address per zone by hand.

## Things worth knowing

- A zone renders only when its profile row is active, Arm is on, a clip is
  selected and Intensity is above zero. A silent rig is almost always Arm off or
  Clip = None.
- ⚠️ **Upgrading from 1.6.0 or earlier**: the `Page` parameter is gone, and with it the
  `Set Page`, `Select Clip` and `Set Clip` commands — any Mapping or Sequence using those
  three has to be rebuilt around **Select Clip Number**. Saved zones migrate themselves:
  the old page and slot are folded into the clip number on load, so every zone comes back
  on the clip it was on.
- ⚠️ A Chataigne enum answers to its **option text** over OSC, so anything selecting a
  clip by name needs `21-1`. That string is now valid whatever state the zone is in,
  which it was not in 1.6.0. `Clip X` / `Clip Y` remain the easier OSC target — plain
  integers.
- Scale 0 renders nothing. Scale is a size, not an offset: `1` is the clip as
  authored (the default), `0` collapses it to nothing, `-1` mirrors it.
  ⚠️ If you're upgrading from module 1.4.0 or earlier: `Scale` used to default
  to 0, and 1.2.1 Build 96 now applies that for real, so zones saved at 0 render
  nothing until set back to 1. The module logs a warning for any zone sitting at
  0 on both axes.
- Universes must exist under *Module Parameters > Output Universes*. Chataigne
  only transmits the universes listed there. One ships with the module
  (Liberation universe 1) and the log names any other universe you need to add.
  Hit **Rebuild Zones** afterwards.
- Leave DMX Type on Art-Net and leave *Send On Change Only* alone (hidden, off by
  default). Liberation drops a zone after 2 seconds without fresh data, so the
  stream has to be continuous. sACN is not supported.
- Removed zones are blanked first. Lowering Zone Count, switching Extended to
  Basic, or re-addressing a zone zeroes the vacated channels, so nothing is left
  streaming an armed state with no UI attached to it.
- After loading a project, the opening push can happen before the saved Output
  Universes exist. The module re-sends everything on the next parameter change,
  and **Rebuild Zones** forces it (it's OSC-addressable, so a startup State can
  fire it).
- You don't need a laser to verify anything: any Art-Net monitor on port 6454
  shows the block. Arm a zone and watch channel 1 go to 255.

## License

GNU General Public License v3, see `LICENSE`. `icon.png` is Liberation's own logo
mark, used to identify the software this module talks to. It remains the property
of its owners and is not covered by the GPL grant.

## Links

- [Liberation](https://www.liberationlaser.com) and the [user manual](https://docs.liberationlaser.com)
- [Chataigne](https://benjamin.kuperberg.fr/chataigne/en) and the [custom module docs](https://benkuperberg.gitbook.io/chataigne-docs/modules/custom-modules/making-your-own-module)
