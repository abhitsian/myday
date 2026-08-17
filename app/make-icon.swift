import Cocoa
import ImageIO
import UniformTypeIdentifiers

// make-icon.swift — draws the app icon and writes AppIcon.icns.
//
// Sunrise over ridgelines: a day beginning, which is what the app is about. The shapes are
// deliberately few and large because the icon has to survive 16pt in the menu bar, where a
// detailed illustration turns to mud. Sun disc, two ridges, a graded sky — that's the whole
// vocabulary, and it still reads at a quarter of an inch.
//
//   swiftc -O -o /tmp/make-icon app/make-icon.swift && /tmp/make-icon app/AppIcon.icns

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.icns"
let S: CGFloat = 1024

// macOS icon geometry: the art sits in a squircle inset from the canvas, so icons of
// different shapes optically match in the Dock.
let inset: CGFloat = 100
let body = CGRect(x: inset, y: inset, width: S - inset * 2, height: S - inset * 2)
let radius: CGFloat = body.width * 0.225

func hex(_ r: Int, _ g: Int, _ b: Int) -> CGColor {
    CGColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1)
}

let cs = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(data: nil, width: Int(S), height: Int(S), bitsPerComponent: 8,
                          bytesPerRow: 0, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    fatalError("could not create context")
}

ctx.setShouldAntialias(true)
ctx.interpolationQuality = .high

// ---- squircle clip -------------------------------------------------------------------
let squircle = CGPath(roundedRect: body, cornerWidth: radius, cornerHeight: radius, transform: nil)
ctx.saveGState()
ctx.addPath(squircle)
ctx.clip()

// ---- sky: night at the top falling to a warm horizon ----------------------------------
let sky = CGGradient(colorsSpace: cs, colors: [
    hex(38, 44, 84),     // deep pre-dawn indigo
    hex(72, 78, 130),
    hex(163, 128, 150),
    hex(238, 160, 120),  // the warm band just above the ridge
    hex(250, 196, 128),
] as CFArray, locations: [0.0, 0.30, 0.55, 0.76, 1.0])!
ctx.drawLinearGradient(sky, start: CGPoint(x: 0, y: body.maxY), end: CGPoint(x: 0, y: body.minY + body.height * 0.30), options: [])

// ---- sun ------------------------------------------------------------------------------
// Sitting low and partly behind the far ridge, so the picture reads as sunrise rather than
// midday. Its glow is a soft radial wash rather than drawn rays, which would break up at
// small sizes.
let sunC = CGPoint(x: body.midX, y: body.minY + body.height * 0.435)
let sunR = body.width * 0.145

let glow = CGGradient(colorsSpace: cs, colors: [
    CGColor(red: 1, green: 0.85, blue: 0.55, alpha: 0.55),
    CGColor(red: 1, green: 0.80, blue: 0.50, alpha: 0.0),
] as CFArray, locations: [0, 1])!
ctx.drawRadialGradient(glow, startCenter: sunC, startRadius: sunR * 0.9,
                       endCenter: sunC, endRadius: sunR * 3.4, options: [])

let disc = CGGradient(colorsSpace: cs, colors: [
    hex(255, 246, 214),
    hex(255, 214, 128),
    hex(252, 176, 92),
] as CFArray, locations: [0, 0.55, 1])!
ctx.saveGState()
ctx.addEllipse(in: CGRect(x: sunC.x - sunR, y: sunC.y - sunR, width: sunR * 2, height: sunR * 2))
ctx.clip()
ctx.drawRadialGradient(disc, startCenter: CGPoint(x: sunC.x, y: sunC.y + sunR * 0.3), startRadius: 0,
                       endCenter: sunC, endRadius: sunR * 1.15, options: [])
ctx.restoreGState()

// ---- ridges ----------------------------------------------------------------------------
// Two layers only. The far one is hazed toward the sky colour so depth comes from value,
// not from outline, and the near one is dark enough to anchor the whole icon.
func ridge(_ pts: [CGPoint], _ fill: CGGradient) {
    let p = CGMutablePath()
    p.move(to: CGPoint(x: body.minX, y: body.minY))
    p.addLine(to: CGPoint(x: body.minX, y: pts[0].y))
    for i in stride(from: 0, to: pts.count - 1, by: 1) {
        let a = pts[i], b = pts[i + 1]
        // Rounded summits: quadratic through the midpoint keeps peaks from reading as spikes.
        let mid = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
        p.addQuadCurve(to: mid, control: a)
        p.addLine(to: b)
    }
    p.addLine(to: CGPoint(x: body.maxX, y: body.minY))
    p.closeSubpath()

    ctx.saveGState()
    ctx.addPath(p)
    ctx.clip()
    ctx.drawLinearGradient(fill, start: CGPoint(x: 0, y: body.midY), end: CGPoint(x: 0, y: body.minY), options: [])
    ctx.restoreGState()
}

let X = { (f: CGFloat) in body.minX + body.width * f }
let Y = { (f: CGFloat) in body.minY + body.height * f }

let farFill = CGGradient(colorsSpace: cs, colors: [hex(120, 112, 150), hex(150, 126, 148)] as CFArray, locations: [0, 1])!
ridge([CGPoint(x: X(-0.05), y: Y(0.40)), CGPoint(x: X(0.20), y: Y(0.52)),
       CGPoint(x: X(0.42), y: Y(0.36)), CGPoint(x: X(0.68), y: Y(0.55)),
       CGPoint(x: X(0.88), y: Y(0.42)), CGPoint(x: X(1.05), y: Y(0.50))], farFill)

let nearFill = CGGradient(colorsSpace: cs, colors: [hex(52, 56, 92), hex(34, 37, 64)] as CFArray, locations: [0, 1])!
ridge([CGPoint(x: X(-0.05), y: Y(0.22)), CGPoint(x: X(0.26), y: Y(0.40)),
       CGPoint(x: X(0.52), y: Y(0.18)), CGPoint(x: X(0.78), y: Y(0.34)),
       CGPoint(x: X(1.05), y: Y(0.20))], nearFill)

ctx.restoreGState()

// ---- edge treatment ---------------------------------------------------------------------
// A hairline inner rim keeps the icon from bleeding into a light Dock background.
ctx.addPath(squircle)
ctx.setStrokeColor(CGColor(red: 0, green: 0, blue: 0, alpha: 0.16))
ctx.setLineWidth(3)
ctx.strokePath()

guard let image = ctx.makeImage() else { fatalError("render failed") }

// ---- write the iconset ------------------------------------------------------------------
let fm = FileManager.default
let tmp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("MyDay.iconset")
try? fm.removeItem(at: tmp)
try! fm.createDirectory(at: tmp, withIntermediateDirectories: true)

let variants: [(Int, String)] = [
    (16, "icon_16x16"), (32, "icon_16x16@2x"), (32, "icon_32x32"), (64, "icon_32x32@2x"),
    (128, "icon_128x128"), (256, "icon_128x128@2x"), (256, "icon_256x256"),
    (512, "icon_256x256@2x"), (512, "icon_512x512"), (1024, "icon_512x512@2x"),
]

for (px, name) in variants {
    guard let c = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
                            space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { continue }
    c.interpolationQuality = .high
    c.draw(image, in: CGRect(x: 0, y: 0, width: px, height: px))
    guard let out = c.makeImage() else { continue }
    let url = tmp.appendingPathComponent("\(name).png")
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { continue }
    CGImageDestinationAddImage(dest, out, nil)
    CGImageDestinationFinalize(dest)
}

let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", tmp.path, "-o", outPath]
try! p.run()
p.waitUntilExit()

// A flat PNG too, for the README and anywhere the icns is the wrong format.
let pngURL = URL(fileURLWithPath: outPath).deletingPathExtension().appendingPathExtension("png")
if let dest = CGImageDestinationCreateWithURL(pngURL as CFURL, "public.png" as CFString, 1, nil) {
    CGImageDestinationAddImage(dest, image, nil)
    CGImageDestinationFinalize(dest)
}

print("wrote \(outPath) and \(pngURL.lastPathComponent)")
