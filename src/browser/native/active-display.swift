import AppKit
import ApplicationServices

func activePoint() -> CGPoint? {
    if let event = CGEvent(source: nil) { return event.location }
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let element = AXUIElementCreateApplication(app.processIdentifier)
    var focused: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &focused) == .success,
          let focused else { return nil }
    let window = focused as! AXUIElement
    var position: CFTypeRef?
    var size: CFTypeRef?
    guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position) == .success,
          AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size) == .success,
          let position, let size else { return nil }
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
          AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
    return CGPoint(x: point.x + dimensions.width / 2, y: point.y + dimensions.height / 2)
}

if let point = activePoint() {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &displays, &count)
    if let display = displays.prefix(Int(count)).first(where: { CGDisplayBounds($0).contains(point) }) {
        let bounds = CGDisplayBounds(display)
        let output = ["left": Int(bounds.minX), "top": Int(bounds.minY),
                      "width": Int(bounds.width), "height": Int(bounds.height)]
        if let data = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]),
           let json = String(data: data, encoding: .utf8) {
            print(json)
            exit(0)
        }
    }
}
exit(1)
