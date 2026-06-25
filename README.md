# ESL for SignalK

A SignalK plugin to display data from SignalK paths, APIs and plugins on Electronic Shelf Labels over a Bluetooth Low Energy (BLE) connection.  

Electronic Shelf Labels (ESLs) are eInk devices that consume very little battery energy, presuming they are not constantly updated - the battery is used only when the display changes, and a periodic BLE check for incoming changes. 

Since they are designed to be used in large quantity in small shops, they are cheap and simple devices. Earlier models required dedicated controllers, or updates over Wifi or NFC, whereas many modern ones are standalone BLE devices that can be updated from a phone or server.

Unlike some eInk projects, this plugin doesn't require any physical modification to the labels, or loading any new firmware. It can send an image to a supported shelf label fresh out of the box.


## Vendors

### Zhsunyco

Also known as 'Suny'

- [BLE ESLs](https://www.zhsunyco.com/digital-display-solution-for-small-retail-business/ble-esl-solution/)
  - The range of labels available on retail sites like Aliexpress may be larger than on their corporate site
  - In mid 2026, a 4 colour (BWRY) 3.7" label retailed for about $35, with quantity discounts for bulk sets
  - Cheapest units are 2 colour 1.54", and they go up to 7.5"

Python code for a variety of their labels at https://github.com/roxburghm/zhsunyco-esl

