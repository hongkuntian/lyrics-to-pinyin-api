qq-qrc-codec.js is adapted from qrc-decoder 1.0.2 by apoint123 under the MIT
license, preserved in LICENSE.qrc-decoder. Its public format implementation
acknowledges SuJiKiNen/LyricDecoder for the original interoperable algorithm.

Source: https://github.com/apoint123/qrc-decoder
Package: https://registry.npmjs.org/qrc-decoder/-/qrc-decoder-1.0.2.tgz
Tarball SHA256: 89d79d45552610efa6e00d93c4630103b51a2b371cf71e9221b11a781c2638be
Original compiled codec SHA256: 615e6c755f78f272da365c8407c60d5aaca3971e1497e8b6d03ed437277656ca

The public constants, key schedule and DES block implementation are retained.
Encryption and package wrappers are removed. Node zlib replaces pako, with
strict hex, bounded inflation, padding and UTF8 validation added. This is a QRC
interoperability codec, not a general-purpose cryptographic implementation.
