# Third-party data

The performer names and aliases in `actress-data.js` are derived from
[Amane](https://github.com/sqzw-x/amane), commit
`45e4f61d5fe2684ccb7aaa09db8e85836ee44a51`.

The Amane-derived mapping data is distributed under GPL-3.0.
The original mapping, its source reference and the GNU General Public License
version 3 are included in `third-party/amane/`. The derived data groups aliases
by the source's person reference, excludes non-person entries and male performers,
and excludes aliases marked as potentially misleading. The transformation is
reproducible with `scripts/build-actress-data.ps1`.

Copyright belongs to the Amane contributors and its upstream contributors.
