# 0.5.1
- Work around `resvg-wasm` font limitations by overriding generic font family with matching font name prior to rendering
# 0.5.0
## Font Handling
- Update set of built-in fonts for consistent Roboto monospace and serif
- Update `tide.svg` template to use explicit font names to work around `resvg-wasm` limitations
## Offline Design
- Offline template development now possible using example data,
  - Pass `-e` or `--example-data` as a CLI argument, pointing to a set of example JSON files
  - Examples of example data provided in plugin and at https://github.com/rhizomatics/signalk-einklabel-plugin/blob/main/examples
  - Works with `render`,`paint`,`field` and `fields`
# 0.4.7
- Fix node-ble imports
# 0.4.6
- Correct `node-ble` dependency to `@naugehyde/node-ble`
# 0.4.5
- Updated `tide.svg` layout
- Added SignalK standard Github Actions workflow
# 0.4.4
- Update `node-ble` to new packaging
# 0.4.3
- Fixed datetime values when running from plugin were blank while CLI was fine
- Added an example Resources API output from signalk-tides plugin
- Relaid out the example tide clock, adding the tidal range (LAT to HAT) and the source of tide data
- Alternative source of time zone info, `source=einklabel,path=local_zone`
# 0.4.2
- Fix High/Low display for tide clock template
- Fix last repaint time for display being hour out
- Change default name of template directory to 'einklabel/templates'
# 0.4.1
- Packaging fixes
# 0.4.0
- Added `einklabel` as a `source` for template fields, and `repainted` as path
- Added `local_datetime_short` as a datetime format option, for `27 Jun 26 18:05` style output
- Add Last Repainted field to the Tide Clock example
# 0.3.2
- Renamed to signalk-einklabel-plugin
- Added core test suite
# 0.3.1
- Correct name, and include changelog
# 0.3.0
- First published beta release
- Tested publishing Tide Clock on interval to a Zhunyco 3.7" display