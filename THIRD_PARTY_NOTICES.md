# Third-party notices

SCALVS.ai can download two routing datasets published by v2fly. The binaries are not part of this repository. `npm run geo:fetch` checks them against the lockfile and the official `.sha256sum` assets, then stores them in the gitignored `data/geo/` directory.

## v2fly geoip

- Project: [v2fly/geoip](https://github.com/v2fly/geoip)
- Work: `geoip.dat`
- Release: `202611080027`
- Upstream: https://github.com/v2fly/geoip/releases/tag/202611080027
- SHA-256: `eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2`
- License: [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/) (CC-BY-SA-4.0)
- Copyright: v2fly geoip contributors
- Changes: none. The file is used unmodified.

Attribution: geoip.dat by the v2fly geoip contributors, licensed under CC-BY-SA-4.0.

## v2fly domain-list-community

- Project: [v2fly/domain-list-community](https://github.com/v2fly/domain-list-community)
- Work: `dlc.dat`, saved locally as `geosite.dat`
- Release: `20261108011013`
- Upstream: https://github.com/v2fly/domain-list-community/releases/tag/20261108011013
- SHA-256: `dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2`
- License: MIT
- Copyright (c) 2018-2019 V2Ray
- Changes: the asset is renamed from `dlc.dat` to `geosite.dat`. Its bytes are unmodified.

```
MIT License

Copyright (c) 2018-2019 V2Ray

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
