import SwiftUI
import TardyCore

/// The 2D floor-plan map: the real plan image with the route, pins and GPS
/// circle drawn on top. Pinch to zoom, drag to pan, tap to pick a spot.
struct FloorPlanView: View {
    let model: AppModel

    @State private var zoom: CGFloat = 1
    @State private var pan: CGSize = .zero
    @GestureState private var pinch: CGFloat = 1
    @GestureState private var drag: CGSize = .zero

    /// Space kept clear of the floor/2D-3D controls and the route panel.
    private let insets = EdgeInsets(top: 120, leading: 12, bottom: PanelLayout.peekHeight + 16, trailing: 12)

    var body: some View {
        GeometryReader { geo in
            if let floor = model.selectedFloor {
                let transform = PlanTransform(container: geo.size, insets: insets,
                                              imageSize: CGSize(width: floor.imageWidth, height: floor.imageHeight),
                                              zoom: clampZoom(zoom * pinch),
                                              pan: CGSize(width: pan.width + drag.width, height: pan.height + drag.height))
                ZStack(alignment: .topLeading) {
                    Color(.secondarySystemBackground)

                    if let image = model.planImage(for: floor) {
                        Image(uiImage: image)
                            .resizable()
                            .interpolation(.high)
                            .frame(width: transform.imageRect.width, height: transform.imageRect.height)
                            .position(x: transform.imageRect.midX, y: transform.imageRect.midY)
                    } else {
                        Text("Floor plan image missing").foregroundStyle(.secondary)
                            .position(x: geo.size.width / 2, y: geo.size.height / 2)
                    }

                    RouteOverlay(model: model, floor: floor, transform: transform)
                        .allowsHitTesting(false)

                    fitButton
                        .position(x: geo.size.width - 34, y: geo.size.height - insets.bottom - 30)
                }
                .contentShape(Rectangle())
                .gesture(
                    SpatialTapGesture().onEnded { value in
                        let p = transform.planPoint(value.location)
                        guard p.x >= 0, p.y >= 0, p.x <= floor.imageWidth, p.y <= floor.imageHeight else {
                            model.tapped = nil
                            return
                        }
                        model.handleTap(at: p, floorId: floor.id)
                    }
                )
                .simultaneousGesture(
                    MagnifyGesture()
                        .updating($pinch) { value, state, _ in state = value.magnification }
                        .onEnded { value in zoom = clampZoom(zoom * value.magnification) }
                )
                .simultaneousGesture(
                    DragGesture(minimumDistance: 6)
                        .updating($drag) { value, state, _ in state = value.translation }
                        .onEnded { value in
                            pan.width += value.translation.width
                            pan.height += value.translation.height
                        }
                )
                .onChange(of: model.focus) { _, request in
                    withAnimation(.snappy) { applyFocus(request, floor: floor, container: geo.size) }
                }
                .onAppear { applyFocus(model.focus, floor: floor, container: geo.size) }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(floor.displayName) floor plan")
                .accessibilityHint("Use the route panel to choose rooms. Pinch to zoom.")
            }
        }
    }

    private var fitButton: some View {
        Button {
            withAnimation(.snappy) {
                zoom = 1
                pan = .zero
            }
        } label: {
            Image(systemName: "arrow.up.left.and.arrow.down.right")
                .font(.body.weight(.semibold))
                .frame(width: 44, height: 44)
                .background(.regularMaterial, in: Circle())
        }
        .accessibilityLabel("Show whole floor")
    }

    private func clampZoom(_ z: CGFloat) -> CGFloat { min(max(z, 0.8), 8) }

    /// Zoom and pan so `request.rect` fills the clear area, or show the whole floor.
    private func applyFocus(_ request: FocusRequest, floor: Floor, container: CGSize) {
        guard request.floorId == floor.id || request.floorId == model.selectedFloorId else { return }
        guard let rect = request.rect else {
            zoom = 1
            pan = .zero
            return
        }
        let base = PlanTransform(container: container, insets: insets,
                                 imageSize: CGSize(width: floor.imageWidth, height: floor.imageHeight),
                                 zoom: 1, pan: .zero)
        let area = base.clearArea
        let fitted = min(area.width / (rect.width * base.baseScale), area.height / (rect.height * base.baseScale))
        zoom = clampZoom(max(1, fitted))
        // Put the rect's centre at the clear area's centre.
        let imageCenter = CGPoint(x: floor.imageWidth / 2, y: floor.imageHeight / 2)
        let s = base.baseScale * zoom
        pan = CGSize(width: (imageCenter.x - rect.midX) * s, height: (imageCenter.y - rect.midY) * s)
    }
}

/// Maps between plan pixels and on-screen points.
struct PlanTransform {
    var container: CGSize
    var insets: EdgeInsets
    var imageSize: CGSize
    var zoom: CGFloat
    var pan: CGSize

    /// The part of the screen not covered by controls or the panel.
    var clearArea: CGRect {
        CGRect(x: insets.leading, y: insets.top,
               width: max(1, container.width - insets.leading - insets.trailing),
               height: max(1, container.height - insets.top - insets.bottom))
    }

    /// Scale that fits the whole plan into the clear area.
    var baseScale: CGFloat {
        min(clearArea.width / imageSize.width, clearArea.height / imageSize.height)
    }

    var scale: CGFloat { baseScale * zoom }

    var origin: CGPoint {
        CGPoint(x: clearArea.midX + pan.width - imageSize.width * scale / 2,
                y: clearArea.midY + pan.height - imageSize.height * scale / 2)
    }

    var imageRect: CGRect {
        CGRect(origin: origin, size: CGSize(width: imageSize.width * scale, height: imageSize.height * scale))
    }

    func screenPoint(_ x: Double, _ y: Double) -> CGPoint {
        CGPoint(x: origin.x + x * scale, y: origin.y + y * scale)
    }

    func planPoint(_ p: CGPoint) -> CGPoint {
        CGPoint(x: (p.x - origin.x) / scale, y: (p.y - origin.y) / scale)
    }
}

/// Route, pins and markers for one floor.
private struct RouteOverlay: View {
    let model: AppModel
    let floor: Floor
    let transform: PlanTransform

    var body: some View {
        Canvas { context, _ in
            let legs = model.foundRoute?.legs ?? []

            // GPS accuracy circle, so the uncertainty is visible.
            if let fix = model.gpsFix, fix.floorId == floor.id {
                let c = transform.screenPoint(fix.point.x, fix.point.y)
                let r = max(8, fix.radiusPixels * transform.scale)
                let circle = Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
                context.fill(circle, with: .color(.blue.opacity(0.12)))
                context.stroke(circle, with: .color(.blue.opacity(0.4)), lineWidth: 1)
            }

            for (index, leg) in legs.enumerated() where leg.floorId == floor.id {
                let dimmed = model.activeLegIndex.map { $0 != index } ?? false
                var path = Path()
                for (i, point) in leg.points.enumerated() {
                    let p = transform.screenPoint(point.x, point.y)
                    if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
                }
                let width = max(4, min(9, 3.5 * transform.scale * 3))
                context.stroke(path, with: .color(.white.opacity(dimmed ? 0.4 : 0.95)),
                               style: StrokeStyle(lineWidth: width + 4, lineCap: .round, lineJoin: .round))
                context.stroke(path, with: .color(Color.blue.opacity(dimmed ? 0.35 : 1)),
                               style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))

                // Where you board or leave a stairwell / elevator.
                if leg.exitConnectorKey != nil, let last = leg.points.last {
                    drawBadge(context, at: transform.screenPoint(last.x, last.y),
                              symbol: last.kind == .elevator ? "arrow.up.arrow.down" : "figure.stairs", color: .orange)
                }
                if index > 0, legs[index - 1].exitConnectorKey != nil, let first = leg.points.first {
                    drawBadge(context, at: transform.screenPoint(first.x, first.y),
                              symbol: first.kind == .elevator ? "arrow.up.arrow.down" : "figure.stairs", color: .orange)
                }
            }

            if let spot = model.tapped, spot.floorId == floor.id {
                let p = spot.place.map { transform.screenPoint($0.markerX, $0.markerY) }
                    ?? transform.screenPoint(spot.point.x, spot.point.y)
                drawBadge(context, at: p, symbol: "mappin", color: .purple)
            }
            if let start = model.startNode, start.floorId == floor.id {
                drawBadge(context, at: transform.screenPoint(start.imageX, start.imageY), symbol: "figure.walk", color: .green)
            }
            if let dest = model.destNode, dest.floorId == floor.id {
                drawBadge(context, at: transform.screenPoint(dest.imageX, dest.imageY), symbol: "flag.fill", color: .red)
            }
        }
    }

    private func drawBadge(_ context: GraphicsContext, at p: CGPoint, symbol: String, color: Color) {
        let r: CGFloat = 13
        let circle = Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r))
        context.fill(circle, with: .color(color))
        context.stroke(circle, with: .color(.white), lineWidth: 2.5)
        var icon = context.resolve(Image(systemName: symbol))
        icon.shading = .color(.white)
        context.draw(icon, in: CGRect(x: p.x - 7.5, y: p.y - 7.5, width: 15, height: 15))
    }
}
