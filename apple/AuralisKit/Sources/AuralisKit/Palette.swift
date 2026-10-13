import Foundation

/// Port of src/lib/palette.ts + color.ts: the "Album Artwork" theme. Builds an always-dark palette from RGBA pixels;
/// only the hue (and a bounded saturation) is borrowed from the cover, so every cover yields readable text.
public struct ArtworkPalette: Equatable, Sendable, Codable {
  /// Hex colours (`#rrggbb`), named after the web tokens.
  public var bg, surface, hover, faint, track, text, textBody, text2, text3, accent, accentLink, accentFill, gradStart, gradEnd: String
  /// Dominant hue in degrees, or nil for grayscale art.
  public var hue: Double?

  private static let buckets = 12
  private static let minChromaticShare = 0.04
  private static let neutralHue = 222.0
  private static let satMin = 0.4, satMax = 0.72
  private static let minTextContrast = 4.5

  /// `pixels`: RGBA bytes, 4 per pixel.
  public static func derive(_ pixels: [UInt8]) -> ArtworkPalette {
    var w = [Double](repeating: 0, count: buckets), x = w, y = w, s = w
    var counted = 0, chromatic = 0
    var i = 0
    while i + 3 < pixels.count {
      defer { i += 4 }
      guard pixels[i + 3] >= 128 else { continue }
      counted += 1
      let (h, sat, l) = ColorMath.rgbToHsl(Double(pixels[i]), Double(pixels[i + 1]), Double(pixels[i + 2]))
      if sat < 0.15 || l < 0.12 || l > 0.88 { continue } // gray, near-black or near-white pixels carry no usable hue
      chromatic += 1
      let weight = sat * (1 - abs(2 * l - 1)) // vivid, mid-lightness pixels count most
      let b = Int(h / (360 / Double(buckets))) % buckets
      w[b] += weight
      x[b] += cos(h * .pi / 180) * weight
      y[b] += sin(h * .pi / 180) * weight
      s[b] += sat * weight
    }
    let top = w.indices.max { w[$0] < w[$1] } ?? 0
    let hasHue = counted > 0 && Double(chromatic) / Double(counted) >= minChromaticShare && w[top] > 0
    let hue: Double? = hasHue ? (atan2(y[top], x[top]) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360) : nil
    let h = hue ?? neutralHue
    let sat = hasHue ? min(satMax, max(satMin, s[top] / w[top])) : 0.85
    let tint = hasHue ? min(sat * 0.45, 0.3) : 0.04

    let hover = ColorMath.hslToHex(h, tint, 0.16) // the lightest background text sits on, so contrast is measured against it
    let c = { (s: Double, l: Double, dir: Double) in ColorMath.withContrast(h, s, l, against: hover, min: minTextContrast, dir: dir) }
    return ArtworkPalette(
      bg: ColorMath.hslToHex(h, tint, 0.08), surface: ColorMath.hslToHex(h, tint, 0.12), hover: hover,
      faint: ColorMath.hslToHex(h, tint, 0.28), track: ColorMath.hslToHex(h, tint, 0.22),
      text: ColorMath.hslToHex(h, 0.12, 0.96), textBody: c(0.1, 0.86, 1), text2: c(0.1, 0.72, 1), text3: c(0.08, 0.64, 1),
      accent: c(sat, 0.66, 1), accentLink: c(sat, 0.74, 1),
      // White text sits on this, so darken until it is readable.
      accentFill: ColorMath.withContrast(h, sat, 0.5, against: "#ffffff", min: minTextContrast, dir: -1),
      gradStart: ColorMath.hslToHex(h, sat, 0.45), gradEnd: ColorMath.hslToHex((h + 40).truncatingRemainder(dividingBy: 360), sat, 0.32),
      hue: hue
    )
  }
}

public enum ColorMath {
  public static func hexToRGB(_ hex: String) -> (Double, Double, Double) {
    let n = Int(hex.replacingOccurrences(of: "#", with: ""), radix: 16) ?? 0
    return (Double((n >> 16) & 255), Double((n >> 8) & 255), Double(n & 255))
  }

  static func rgbToHex(_ r: Double, _ g: Double, _ b: Double) -> String {
    "#" + [r, g, b].map { String(format: "%02x", Int(min(255, max(0, $0)).rounded())) }.joined()
  }

  /// h in degrees [0,360), s and l in [0,1].
  static func rgbToHsl(_ r: Double, _ g: Double, _ b: Double) -> (Double, Double, Double) {
    let rn = r / 255, gn = g / 255, bn = b / 255
    let mx = max(rn, gn, bn), mn = min(rn, gn, bn)
    let l = (mx + mn) / 2, d = mx - mn
    if d == 0 { return (0, 0, l) }
    let s = d / (1 - abs(2 * l - 1))
    let h = mx == rn ? ((gn - bn) / d).truncatingRemainder(dividingBy: 6) : mx == gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4
    return ((h * 60 + 360).truncatingRemainder(dividingBy: 360), s, l)
  }

  static func hslToHex(_ h: Double, _ s: Double, _ l: Double) -> String {
    let a = s * min(l, 1 - l)
    func f(_ n: Double) -> Double {
      let k = (n + h / 30).truncatingRemainder(dividingBy: 12)
      return l - a * max(-1, min(k - 3, 9 - k, 1))
    }
    return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255)
  }

  /// WCAG relative luminance.
  static func luminance(_ hex: String) -> Double {
    let (r, g, b) = hexToRGB(hex)
    func lin(_ v: Double) -> Double { let c = v / 255; return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  }

  /// WCAG contrast ratio, 1–21.
  public static func contrast(_ a: String, _ b: String) -> Double {
    let la = luminance(a), lb = luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
  }

  /// Step lightness toward lighter/darker until the colour has `min` contrast with `against`.
  static func withContrast(_ h: Double, _ s: Double, _ l: Double, against: String, min target: Double, dir: Double) -> String {
    var l = l, hex = hslToHex(h, s, l), step = 0
    while step < 100 && contrast(hex, against) < target {
      l = Swift.min(1, Swift.max(0, l + dir * 0.01))
      hex = hslToHex(h, s, l)
      step += 1
    }
    return hex
  }
}
