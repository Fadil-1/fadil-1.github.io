---
layout: 8-bit_breadboard_CPU
title: OLED
mathjax: true
similar: 8-bit-computers
date_child: "May 27, 2023"
last_updated: "April 28, 2026"
category: children
parent: 8-bit_breadboard_CPU
permalink: /blog/8-bit_breadboard_CPU/oled_display/ 
--- 


# OLED Display

# BASICS PRIMER
<div class="grey-background">
<p>Unlike traditional LCD (Liquid Crystal Displays), which rely on a uniform backlight, each pixel in an OLED(Organic Light-Emitting Diode) display emits its own light. This makes color contrasts look very vibrant. Typically, LCDs used for minimal projects, such as the HD44780 based LCD2004, have convenient built-in features such as "auto increment after read/write". On these LCDs, characters and symbols can be placed at pre-encoded dot-matrix blocks within the display.</p>

<p>On the other hand, similarly-sized OLED displays are controlled on a pixel-base. While this offers more control over each pixel, it also introduces greater complexity in programming and control as each pixel must be addressed and manipulated independently, which can be more challenging and time-consuming.</p>
</div>

I use the Adafruit 2.7" Monochrome 128x64 OLED Display Module. It has both SPI and 8-bit parallel mode(6800 and 8080). Since my build is relatively slow(At least compared to commercial MCUs), I use the parallel mode; 6800 specifically since it’s simpler and more common than 8080. The display is driven by the Solomon Systech [SSD1325](http://www.adafruit.com/datasheets/SSD1325.pdf) OLED driver and uses 3V logic HIGH, so I use some level shifters to step down the 5V voltage coming from other parts of the CPU into the displays' 3V input pins. The LOW input(3.3V) of the level shifters comes from a very convenient 3.3V output from the SD card reader.

# Implementation

Below's an image of the OLED display module:

<figure>
    <img src="{{ site.url }}{{ site.baseurl }}/assets/img/posts/8-bit_bb_cpu/oled/0.png" alt="Figure 1: OLED Module Schematic">
    <figcaption>Figure 1: OLED Module Schematic</figcaption>
</figure>
<br>

## **Control/Pins lines involved (10):**
- \|← Pin 4 - **~OS** (**data/command selector pin)**.  A LOW in OS corresponds to a COMMAND read/write and a HIGH OS indicates a DATA read/write.
- \|← Pin 5 - **OD** (**Data/Write control pin**).
- \|← Pin 6 - **~OE** (**Enable/Latch control pin**).
- →\|← Pin 7 to 14 - **D0** (**Data pin 0 to 7**)
- \|← Pin 15 - **CS** (**Active Low Chip Select pin,** always tied to ground).
- \|← Pin 16 - **OC** (Clear/Reset pin).

**~OE** is the data latch trigger when **OD** is LOW, with data being latched at the falling edge of **~OE**. Note from the schematic that **OD** is tied to the "direction" pin of the bus transceiver. This means that, unless data is being read from the display(in other words the display is outputting to the data bus), the bus transceiver is always going to direct data from the data bus to the display. And the display always sensing the content of the bus is not an issue because it does not latch any data unless **~OE** gets asserted.

<figure>
    <img src="{{ site.url }}{{ site.baseurl }}/assets/img/posts/8-bit_bb_cpu/oled/1.jpg" alt="Figure 2: Control pins of 6800 interface - Solomon Systech">
    <figcaption>Figure 2: Control pins of 6800 interface - Solomon Systech</figcaption>
</figure>
<br>


# Display Initialization

To understand how commands are sent to the display, let's first go through the command format as described in the datasheet.

## Command Format

The OLED display's controller uses a combination of command and data bytes to control its operation. The commands are used as follows:

1. **Setting the ~OS Pin**: As mentioned before, this pin determines whether the byte being sent is a command (~OS = 0) or data (~OS = 1).
2. **Sending the Command Byte**: This is the first byte sent after setting the ~OS pin to 0. It typically consists of a unique pattern that identifies the command, as outlined in the datasheet.
3. **Sending Additional Bytes (if required)**: Some commands require additional data bytes to complete the command. These bytes follow the command byte.

For example, to set the column address:

- First, send the command byte `0b00010101` (Hex 15). This tells the OLED to prepare to receive the column address settings.
- Then send the column start address, e.g., `0b00000000` for starting at column 0.
- Finally, send the column end address, e.g., `0b00111111` for ending at column 63.


Address are simply latched after setting ~OS = 1.
<figure>
    <img src="{{ site.url }}{{ site.baseurl }}/assets/img/posts/8-bit_bb_cpu/oled/2.png" alt="Figure 3: command_table - Solomon Systech">
    <figcaption>Figure 3: command_table - Solomon Systech</figcaption>
</figure>
<br>

The rest of the table is included in the datasheet starting at page 31.

On page 6 of the SSD1325 datasheet:<br>
 "*SSD1325 displays data directly from its internal 128x80x4 bits Graphic Display Data RAM (GDDRAM). Data/Commands are sent from general MCU through the hardware selectable 6800-/8080-series compatible Parallel Interface or Serial Peripheral Interface.*"<br> 

This means that by default, the SSD1325 expects to interact with a 128x80 display. Since the display I use is a 128x64, the start and end GDDRAM addresses must be adjusted accordingly.

The SSD1325 operates with a 4-bit grayscale depth, meaning that it uses 4 bits to represent one of 16 different shades of gray for each pixel. In the controller's GDDRAM, which is a bitmapped static RAM holding the bit pattern to be displayed, the data is organized such that each byte corresponds to two pixels. When data is written to the GDDRAM, the lower and higher nibbles of each data byte represent the grayscale levels for two consecutive pixels. This design choice optimizes the memory layout of the display while maintaining the mechanical flexibility to remap the display through software as needed. Note that because a pixel only requires a nibble; a page/buffer for the display is actually 64x64 bytes instead of 128x64.

The datasheet also describes the "Set Re-map" command (A0h), which lets you configure the pointer position, as well as the orientation and progression of data within the display's memory for standard top-left to bottom-right rendering of images and text. This is very handy for customizing the display to match specific writing/drawing requirements.

<figure>
    <img src="{{ site.url }}{{ site.baseurl }}/assets/img/posts/8-bit_bb_cpu/oled/3.png" alt="Figure 4: Examples of Address Pointer Movement - Solomon Systech">
    <figcaption>Figure 4: Examples of Address Pointer Movement - Solomon Systech</figcaption>
</figure>
<br>

## Initialization Sequence

The initialization sequence below, among many things, mainly clears any residual data, sets the display start line and offsets for correct image positioning, and finally, turns the display ON.

**0- Hard Reset**:
- Hold Reset line for a couple cycles.<br>

**1- Turn the Display OFF**
- Send `10101110` / `0xAE`<br>

**2- Set Column Address**:
- Send `0b0010101` / `0x15` (command to set column address).
- Send `0b00000000` / `0x00` (start column at 0).
- Send `0b00111111` / `0x3F` (end column at 63, which accounts for 128 pixels as each column consists of two pixels).<br>

**3- Set Row Address**:
- Send `0b01110101` / `0x75` (command to set row address).
- Send `0b00000000` / `0x00` (start from 0).
- Send `0b00111111` / `0x3F` (end row at 64).<br>
  
**4- Set Contrast Current**:
- Send `0b10000001` / `0x81` (command to set contrast).
- Send `0b01111111` / `0x7F` (specific contrast level).<br>
  
**5- Set Remap**:
- Send `0b10100000` / `0xA0` (command to set remap).
- Send `0b01010010` / `0x52` (specific remap settings to Increment pixel cursor from left to right and top to bottom).<br>

**6- Set Display Start Line**:
- Send `0b10100001` / `0xA1` (command to set start line).
- Send `0b00000000` / `0x00` (start line 0).<br>

**7- Set Display Offset**:
- Send `0b10100010` / `0xA2` (command to set display offset).
- Send `0b01001011` / `0x4B` (offset value 75).<br>
  
**8- Set Display Mode**:
- Send `0b10100100` / `0xA4` (A4(Totally OFF) A5(Totally ON)).<br>

**9- Set Full Current Range**
- Send `0b10000110` / `0x86` (Maximum current: Lowest divide ratio and highest oscillator frequency)<br>
  
**10- Set Clock Divide Ratio and clock frequency**
- Send `0b10110011` / `0xB3`
- Send `0b11110001` / `0xF1` (Max Clock frequency)<br>

**11- Set MUX Ratio for highest frequency**
- Send `0b10101000` / `0xA8`
- Send `0b00111111` / `0x3F` (1/64)<br>

**12- Set Gray Scale Table**
- Send `0b10111000` / `0xB8`

- Send `0b00000001` / `0x01`
- Send `0b00010001` / `0x11`
- Send `0b00100010` / `0x22`
- Send `0b00110010` / `0x32`
- Send `0b01000011` / `0x43`
- Send `0b01010100` / `0x54`
- Send `0b01100101` / `0x65`
- Send `0b01110110` / `0x76`

**13- Draw filled black rectangle(Essentially clearing the display)**
- Send `0b00100100` / `0x24`
- Send `0b00000000` / `0x00`
- Send `0b00000000` / `0x00`
- Send `0b00111111` / `0x3F`
- Send `0b00111111` / `0x3F`
- Send `0b00000000` / `0x00`

**14- Turn the Display ON**:
- Send `0b10101111` / `0xAF` (command to turn on the display).