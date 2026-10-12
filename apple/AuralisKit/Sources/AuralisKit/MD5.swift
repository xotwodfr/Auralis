import Foundation

/// Subsonic token auth needs MD5 (`t = md5(password + salt)`). Pure Swift so it also runs on Linux
/// where CryptoKit is unavailable.
enum MD5 {
  private static let s: [UInt32] = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
  private static let k: [UInt32] = (0..<64).map { i -> UInt32 in
    let scaled: Double = abs(sin(Double(i + 1))) * 4294967296.0
    return UInt32(scaled)
  }

  static func hex(_ input: String) -> String {
    var message = Array(input.utf8)
    let bitLength = UInt64(message.count) * 8
    message.append(0x80)
    while message.count % 64 != 56 { message.append(0) }
    for i in 0..<8 { message.append(UInt8(truncatingIfNeeded: bitLength >> (8 * UInt64(i)))) }

    var a0: UInt32 = 0x67452301, b0: UInt32 = 0xefcdab89, c0: UInt32 = 0x98badcfe, d0: UInt32 = 0x10325476
    for chunk in stride(from: 0, to: message.count, by: 64) {
      var m = [UInt32](repeating: 0, count: 16)
      for i in 0..<16 {
        for byte in 0..<4 {
          let value: UInt32 = UInt32(message[chunk + i * 4 + byte])
          m[i] |= value << UInt32(8 * byte)
        }
      }
      var a = a0, b = b0, c = c0, d = d0
      for i in 0..<64 {
        var f: UInt32
        let g: Int
        switch i {
        case 0..<16: f = (b & c) | (~b & d); g = i
        case 16..<32: f = (d & b) | (~d & c); g = (5 * i + 1) % 16
        case 32..<48: f = b ^ c ^ d; g = (3 * i + 5) % 16
        default: f = c ^ (b | ~d); g = (7 * i) % 16
        }
        f = f &+ a &+ k[i] &+ m[g]
        a = d; d = c; c = b
        let shift = s[(i / 16) * 4 + i % 4]
        b = b &+ ((f << shift) | (f >> (32 - shift)))
      }
      a0 = a0 &+ a; b0 = b0 &+ b; c0 = c0 &+ c; d0 = d0 &+ d
    }
    var hex = ""
    for word in [a0, b0, c0, d0] {
      for byte in 0..<4 { hex += String(format: "%02x", (word >> UInt32(8 * byte)) & 0xff) }
    }
    return hex
  }
}
