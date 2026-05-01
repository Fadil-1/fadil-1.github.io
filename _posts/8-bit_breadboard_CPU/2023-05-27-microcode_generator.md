---
layout: 8-bit_breadboard_CPU
title: Microcode Generator
mathjax: true
similar: 8-bit-computers
date_child: "May 27, 2023"
last_updated: "April 28, 2026"
category: children
parent: 8-bit_breadboard_CPU
permalink: /blog/8-bit_breadboard_CPU/microcode_generator/
---

# Microcode Generator

The control unit of my CPU depends on three microcode EPROMs. At each micro-step, those EPROMs receive the current instruction, flag state, interrupt state, and step-counter value as address inputs. The byte values stored at that address then appear on the ROM output pins as control signals for the rest of the CPU.

Because the ROM address space depends on several CPU states at once, the final microcode image is too large and too error-prone to write by hand. A small change to a flag condition or interrupt path can affect many ROM addresses. I use a Python generator to describe each instruction as a sequence of micro-operations and produce the final EPROM binary files.

In addition to the ROM images, the generator also produces supporting files for the project, including CustomASM rule definitions and instruction documentation. This article explains how the generator is organized and how it connects the CPU’s instruction set to the actual control signals stored in the microcode ROMs.

## Microcode ROM Address Format

The microcode ROM is made from three M27C4002 EPROMs. Each EPROM is organized as 256K x 16, which means each chip has 18 address inputs and 16 output bits. The three chips share the same 18-bit address input, but each chip stores a different 16-bit slice of the full 48-bit control word.

**ROM**: 3x M27C4002 EPROMs

**Input address format, from MSB A17 to LSB A0:**

- **Instruction**: 8 bits, from A17 through A10
- **II**: Interrupt Inhibit flag, A9
- **IRQ**: Interrupt Request flag, A8
- **Step counter**: 4 bits, from A7 through A4
- **Zero flag (Z)**: A3
- **Overflow flag (O)**: A2
- **Negative flag (N)**: A1
- **Carry flag (C)**: A0

This produces an 18-bit ROM address. Since `2^18 = 262144`, each microcode ROM contains 262,144 addressable words.

```text
A17 ... A10   A9   A8   A7 ... A4   A3   A2   A1   A0
Instruction   II   IRQ  Step        Z    O    N    C
```

The ROM outputs are arranged as one 48-bit control word split across three physical EPROMs:

```text
ROM 0: control bits 15  through 0
ROM 1: control bits 31  through 16
ROM 2: control bits 47  through 32
```

## Control Word Layout

Each control signal is represented as one bit in a larger Python control word. The three physical ROMs each output 16 bits, so the script treats the full control word as a 48-bit value and later splits it into three 16-bit ROM images.

A small excerpt from the control-line definitions looks like this:

```python
# ROM 0
_CLKW  = 1 <<  15  #  Clock speed select
# ...
_OC    = 1         #  OLED clear

# ROM 1
EX     = 1 <<  31 #  Extra (Extra/Unused control line)
# ...
_SPC   = 1 <<  16 #  Stack pointer count enable

# ROM 2
_SPE   = 1 <<  47 #  Stack pointer word(16-bits) enable
# ...
# 74HCT238 3-to-8 non inverting decoder
WR_2   = 1 <<  38 #  Write decoder A2
WR_1   = 1 <<  37 #  Write decoder A1
WR_0   = 1 <<  36 #  Write decoder A0
# 74HCT154 4-to-16 inverting decoder
RD_3   = 1 <<  35 #  Read decoder A3
RD_2   = 1 <<  34 #  Read decoder A2
RD_1   = 1 <<  33 #  Read decoder A1
RD_0   = 1 <<  32 #  Read decoder A0
```

The full list is in the generator script. The important idea is that each named control signal corresponds to a specific bit position in the 48-bit control word.

## Decoder-Generated Control Lines

Not every named control signal is driven by a dedicated ROM output bit. Some ROM outputs feed decoder chips that generate groups of mutually exclusive control lines.

For example, the 74HCT154 is an inverting 4-to-16 decoder. In my circuit, its outputs are connected to active-low enable inputs. Because of that, the Python code can treat those decoded enable signals as if they are active-high names. The hardware inversion and active-low target inputs cancel each other from the point of view of the microcode definition.

A simplified example:

```python
# 74HCT238 write/select decoder
SdW = WR_2 | WR_1 | WR_0 # Segmented display write
IW  = WR_2 | WR_1        # Interrupt register write
SdT = WR_2 |        WR_0 # Segmented display temporary register write
CW  =        WR_1 | WR_0 # C register write
AW  =        WR_1        # A register write

# 74HCT154 enable decoder
ZE   = RD_3 | RD_2 | RD_1 | RD_0 # Accumulator enable
DE   = RD_3 | RD_2 | RD_1        # D register enable
CE   = RD_3 | RD_2 |        RD_0 # C register enable
AE   = RD_3 | RD_2               # A register enable
BE   = RD_3 |        RD_1 | RD_0 # B register enable
FE   = RD_3 |        RD_1        # Flags register enable
BRhE = RD_3 |               RD_0 # Transfer Register upper byte enable
BRlE = RD_3                      # Transfer Register lower byte enable
SPhE =        RD_2 | RD_1 | RD_0 # Stack Pointer upper byte enable
SPlE =        RD_2 | RD_1        # Stack Pointer lower byte enable
IE   =        RD_2 |        RD_0 # Interrupt register enable
ME   =        RD_2               # Memory enable to 8-bit bus
```

This is why the control unit can address more named control outputs than the 48 direct ROM output pins. Some of the outputs are direct, while others are decoded from smaller control fields.

## Active-Low Normalization

Many signals in the CPU are active-low. In the microcode definitions, I still write a control word as if asserting a named signal means "activate this function." Before writing the ROM files, the script normalizes active-low signals so inactive active-low lines are stored as HIGH in the EPROM output.

```python
active_low_lines = _CLKW | _DW | _BW | _HC | _FW | _OE | _OS | _OC | _ScR | \
_PChE | _PClE | _EE | _PSE | _PSW | _SPC | _SPE | _MW | \
_BRE | _PCE | _PCW | _PS

def al_norm(microcode):
    """
    Active-low normalization.

    Maintains active-low lines HIGH and active-high lines LOW when inactive
    by XORing the current control word with the bit positions of all
    active-low lines.
    """
    return microcode ^ active_low_lines
```

This lets the instruction definitions stay readable. I can write `_PCE | ME | IR_in | PCC` to describe the logical operation, and the generator handles which physical ROM output bits must be HIGH or LOW.

## Fetch and Instruction Micro-Operations

Every normal instruction starts with the same fetch step:

```python
FETCH = [_PCE | ME | IR_in | PCC]
```

During fetch, the Program Counter drives the memory/system bus, memory outputs the opcode byte onto the data bus, the Instruction Register loads that byte, and the Program Counter increments.

The `full_microcode()` helper prepends that fetch step automatically. It also inserts `_ScR` at the first empty step, so the micro-step counter resets when the instruction is complete.

```python
def full_microcode(*steps):
    """
    Creates full microcode for one instruction.
    t_0 is automatically prepended with the fetch cycle.
    The first empty step is replaced with _ScR.
    """
    global adr

    step_list = list(steps)
    step_list.extend([0] * (15 - len(step_list)))

    for i, step in enumerate(step_list):
        if step == 0:
            step_list[i] = _ScR
            break

    adr += 1
    return FETCH + step_list
```

This keeps instruction definitions compact. For example, `STC` and `CLC` only need one explicit micro-operation after fetch:

```python
add_microcode(full_microcode(FLG_STC | _FW), "STC")
add_microcode(full_microcode(FLG_CLC | _FW), "CLC")
```

## Defining Instructions

The generator stores each instruction in a dictionary keyed by its opcode address.

```python
instructions_without_flags = dict()

def add_microcode(micro_operations, name):
    """
    Adds one instruction definition to the base instruction table.
    """
    instructions_without_flags[adr] = micro_operations, name
```

The base table stores instructions before flag-dependent behavior is applied. Later, the generator copies this table for every flag combination.

Simple immediate instructions fetch one operand byte from the next memory location. For example, `MOV $A, #` reads the byte at the current Program Counter address, writes it into register A, and increments the Program Counter:

```python
add_microcode(
    full_microcode(_PCE | ME | AW | PCC),
    "MOV $A, #"
)
```

Absolute-address instructions fetch a 16-bit operand into the Transfer Register before accessing memory. For example, `MOV $A, [@]` fetches the lower address byte, fetches the upper address byte, then uses the Transfer Register to select the memory address whose value should be loaded into register A:

```python
add_microcode(
    full_microcode(
        _PCE | ME | BRlW | PCC,
        _PCE | ME | BRhW,
        _BRE | ME | AW | PCC
    ),
    "MOV $A, [@]"
)
```

The notation used by the generator follows the same convention as the assembler rules:

```text
$     Register
#     Immediate number
@     16-bit address
[]    Memory location
[@]   Memory at a 16-bit address operand
[$CD] Memory at the address stored in registers C and D
```

## Reset Vector

Instruction `0x00` executes the CPU reset sequence. It brings the CPU into a known state, prepares the OLED reset line, clears key registers, initializes the stack, and jumps to the bootloader ROM at `0xC000`.

At a high level, the reset sequence does this:

```text
1. Clear the accumulator and hold OLED reset active.
2. Use the known zero value to clear registers and flags.
3. Clear the segmented-display temporary/output registers.
4. Build 0xC000 in the Transfer Register.
5. Load the Stack Pointer with 0xC000.
6. Decrement the Stack Pointer once, leaving SP = 0xBFFF.
7. Load the Program Counter with 0xC000.
8. Fetch the first bootloader opcode from 0xC000.
```

This matches the memory map used elsewhere in the project: the bootloader ROM begins at `0xC000`, while the stack starts at `0xBFFF` and grows downward into RAM.

A simplified excerpt of the reset sequence is:

```python
INACTIVE = al_norm(active_low_lines)

instructions_without_flags[adr] = ([
    ALU_ZERO | ZW | _OC,                              # Clear accumulator and reset OLED.
    ZE | AW | BRlW | BRhW | IR_in | _OC,              # Clear A, bridge, and IR.
    ZE | CW | FLG_MIRROR_BUS | _FW | _OC,             # Clear C and flags.
    ZE | SdT,                                         # Clear segmented-display temporary register.
    ZE | SdW | _BW | _DW | EW | SHIFT_REG_SR | H_cin, # Clear B, D, E; prepare shift register.
    SHIFT_REG | ZW,                                   # Load 0x80 into accumulator.
    ZE | SHIFT_REG_SR | H_cin,                        # Build 0xC0 in shift register.
    SHIFT_REG | ZW,                                   # Load 0xC0 into accumulator.
    ZE | BRhW,                                        # Bridge is now 0xC000.
    _BRE | SPW,                                       # Load SP with 0xC000.
    _SPC | SPD,                                       # Count SP down to 0xBFFF.
    _BRE | _PCW,                                      # Load PC with 0xC000.
    TI,                                               # Toggle interrupt inhibit.
    INACTIVE, INACTIVE,                               # Padding.
    _PCE | ME | IR_in                                 # Fetch first opcode from 0xC000.
], "RST")
```

## Conditional Jumps

The base instruction table first stores conditional jumps in their default fall-through form. Later, the generator creates a copy of the instruction table for every possible flag combination. For each copy, it rewrites conditional jumps depending on whether the relevant flag is active.

The helper below applies the common conditional-branch logic:

```python
def apply_conditional_branching(flags):
    Z = flags & Z_Flag
    O = flags & O_Flag
    N = flags & N_Flag
    C = flags & C_Flag

    cond_jmp(microcode[flags][JZ]) if Z else cond_jmp(microcode[flags][JNZ])
    cond_jmp(microcode[flags][JO]) if O else cond_jmp(microcode[flags][JNO])
    cond_jmp(microcode[flags][JN]) if N else cond_jmp(microcode[flags][JP])
    cond_jmp(microcode[flags][JC]) if C else cond_jmp(microcode[flags][JNC])

    if not N and not Z:
        cond_jmp(microcode[flags][JGZ])
```

This is why the ROM address includes the flags. The same opcode can produce different control signals depending on the current flag state.

## Interrupt Handling

The ROM address also includes the Interrupt Inhibit flag and Interrupt Request flag. When an interrupt request is active and interrupts are not inhibited, the generator modifies most instruction sequences so they branch into the interrupt handler after the current instruction reaches its normal reset point.

The interrupt handler address is stored in the interrupt register path, and the generator uses a special jump sequence to redirect execution to that address.

```python
jump_to_interrupt_handler = [
    ALU_ZERO | ZW | IW, # Write the hardwired interrupt vector into the interrupt register.
    ZE | BRhW,          # Write 0 into upper byte of bridge.
    IE | BRlW,          # Write interrupt address into lower byte of bridge.
    _BRE | _PCW,        # Load PC with interrupt handler address.
    _ScR                # Reset the micro-step counter.
]
```

The implementation is still part of the larger interrupt system, so the article on interrupts will eventually explain the hardware and software behavior in more detail.

## Applying Flag-Dependent Behavior

After the base instruction table is created, the generator makes one copy of that table for each possible flag combination.

```python
microcode = [
    deepcopy(microcode_dict)
    for _ in range((C_Flag | Z_Flag | N_Flag | O_Flag | II_Flag | IRQ_Flag) + 1)
]
```

Then `generate_microcode()` walks through those flag combinations and modifies the copied instruction tables.

```python
def generate_microcode():
    for flags in range((II_Flag | IRQ_Flag | Z_Flag | O_Flag | N_Flag | C_Flag) + 1):
        II  = flags & II_Flag
        IRQ = flags & IRQ_Flag

        try:
            if IRQ and II:
                apply_conditional_branching(flags)

            elif IRQ:
                apply_conditional_branching(flags)

                for instruction, micro_operations in microcode[flags].items():
                    if instruction == 0 or instruction == interrupt_handler_address:
                        continue

                    if number_of_fillers and instruction in range((256 - number_of_fillers), 256):
                        continue

                    cond_jmp(micro_operations, jp=jump_to_interrupt_handler)

            elif II:
                cond_jmp(microcode[flags][CII], clear_II)
                apply_conditional_branching(flags)

            else:
                cond_jmp(microcode[flags][SII], set_II)
                apply_conditional_branching(flags)

        except Exception:
            trace = traceback.format_exc()
            print(f"ERROR!! NOT ENOUGH STEPS REMAINING FOR JUMP\n{trace}")
            exit()
```

This is the step that turns the base microcode into the final flag-aware microcode ROM contents.

## Splitting the Control Word Across ROMs

Before writing the binary files, the generator normalizes active-low lines and extracts the 16-bit slice for each EPROM.

```python
def trim_word(rom_number, microcode):
    """
    Returns the 16-bit slice of the 48-bit control word for one EPROM.
    """
    return (microcode >> (16 * rom_number)) & 0xFFFF
```

Then `assign_rom()` creates one ROM-specific copy of the microcode table.

```python
def assign_rom(microcode_list, rom_number):
    """
    Normalizes each control word and isolates the 16-bit slice for one ROM.
    """
    eprom = deepcopy(microcode_list)

    for microcode_dict in eprom:
        for instruction in microcode_dict:
            for i, control_word in enumerate(microcode_dict[instruction]):
                microcode_dict[instruction][i] = trim_word(
                    rom_number,
                    al_norm(control_word)
                )

    return eprom

roms = [
    assign_rom(microcode, 0),
    assign_rom(microcode, 1),
    assign_rom(microcode, 2)
]
```

At this point, the script has the complete contents for `ROM 0`, `ROM 1`, and `ROM 2`.

## Generating the ROM Images

The final binary generation step iterates through the entire physical address space of each EPROM. For each address, it decodes the address bits back into instruction, flags, and micro-step fields, then retrieves the correct 16-bit output word.

The current version writes each ROM image into a `bytearray` first, then writes the whole buffer to disk in one operation.

```python
def generate_microcode_rom():
    for i, rom in enumerate(roms):
        print(f'\nWriting Microcode for rom_{i}...', end='', flush=True)
        buffer = bytearray(ROM_SIZE * 2)

        for address in range(ROM_SIZE):
            instruction = (address & 0b111111110000000000) >> 10
            flags_h = (address & 0b00000001100000000) >> 4
            flags_l = address & 0b1111
            flags = flags_h | flags_l
            step = (address & 0b000000000011110000) >> 4

            word = rom[flags][instruction][step]
            buffer[address * 2] = word & 0xFF
            buffer[address * 2 + 1] = (word >> 8) & 0xFF

        with open(f"microcode_rom_{i}.bin", "wb") as file:
            file.write(buffer)

    print("\nDone!")
```

This generates the three binary files that get programmed into the microcode EPROMs:

```text
microcode_rom_0.bin
microcode_rom_1.bin
microcode_rom_2.bin
```

## Generating the CustomASM Rule Definitions

The same script also generates ruledef.asm for CustomASM.

For immediate instructions, the generated rule appends one byte after the opcode. For absolute-address instructions, it appends a 16-bit little-endian address after the opcode.

The generated `ruledef.asm` file is what lets me write assembly like this:

```nasm
MOV $A, 2
MOV $B, 8
CLC
ADD $A, $B
```

instead of manually writing opcode bytes.

A simplified version of the rule-generation logic is:

```python
def generate_ruledef(use_new_le=False):
    """
    Generates a ruledef.asm directive file for CustomASM.
    """
    with open("ruledef.asm", "w") as ruledef:
        ruledef.writelines("#ruledef\n{\n")

        for i, (instruction, _) in enumerate(instructions_dict.items()):
            parts = instruction.split()
            end = ""
            formatted_parts = []

            if "@" in instruction:
                end = "@le(address)" if use_new_le else "@ le(address)"
            elif "#" in instruction:
                end = "@ im"

            for part in parts:
                if "@" in part:
                    formatted_parts.append(
                        part.replace("@", "address: u16")
                            .replace("[", "{")
                            .replace("]", "}")
                    )
                elif "#" in part:
                    formatted_parts.append(part.replace("#", "{im: i8}"))
                else:
                    formatted_parts.append(part)

            rebuilt_instruction = " ".join(formatted_parts)
            ruledef.writelines(f"    {rebuilt_instruction.ljust(25)} => 0x{i:02x} {end}\n")

        ruledef.writelines("}\n")
```

## Generating the Instruction Reference

The script also generates an instructions.md file, which lists each instruction, its opcode, and the control signals asserted at each micro-step.

That generated file is useful because it gives me a readable instruction reference without manually maintaining a separate table. When the microcode changes, I can regenerate the instruction documentation from the same source that generates the ROM images.

## Generated Files

The generator produces the main files needed by the rest of the project:

```text
microcode_rom_0.bin
microcode_rom_1.bin
microcode_rom_2.bin
ruledef.asm
instructions.md
```

The binary files are programmed into the three M27C4002 microcode EPROMs. The `ruledef.asm` file is used by CustomASM. The `instructions.md` file documents the generated instruction set and micro-operations.

This keeps the hardware control logic, assembler syntax, and instruction documentation tied to the same source of truth.