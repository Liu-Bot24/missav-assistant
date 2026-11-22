# Third-party data

This extension is released under the MIT License in `LICENSE`, except for the
following files, which are distributed under the GNU General Public License,
version 3 (GPL-3.0), in `third-party/amane/LICENSE`:

- `third-party/amane/mapping_actor.xml`: the performer mapping from
  [Amane](https://github.com/sqzw-x/amane), commit
  `45e4f61d5fe2684ccb7aaa09db8e85836ee44a51`, unmodified.
- `actress-data.js`: a modified version of that mapping, last modified 2026-11-22.

Changes made in `actress-data.js`:

- The mapping is converted from XML to JavaScript, keeping each performer's
  source reference, Chinese name and aliases.
- Entries for non-people and male performers are not performer records. Their
  names are listed separately as ignored aliases.
- Aliases carrying a source annotation are removed from the records. Spellings
  marked as easily confused or shared by different people are listed separately
  as caution aliases.

The original mapping is included, so `actress-data.js` can be rebuilt with
`scripts/build-actress-data.ps1`.

Copyright in the mapping belongs to the Amane contributors and its upstream
contributors.
