import SwiftUI
import TardyCore

struct ContentView: View {
    @Bindable var model: AppModel
    @State private var detent: PresentationDetent = .height(PanelLayout.peekHeight)

    var body: some View {
        ZStack(alignment: .top) {
            Group {
                switch model.mapMode {
                case .plan:
                    FloorPlanView(model: model)
                case .model:
                    Building3DView(model: model)
                }
            }
            .ignoresSafeArea()

            VStack(spacing: 10) {
                MapControls(model: model)
                if let tapped = model.tapped, model.mapMode == .plan {
                    TappedSpotCard(model: model, spot: tapped)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                if let banner = model.banner {
                    BannerView(text: banner) { model.banner = nil }
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 4)
            .animation(.snappy, value: model.tapped)
            .animation(.snappy, value: model.banner)
        }
        .sheet(isPresented: .constant(true)) {
            RoutePanel(model: model, detent: $detent)
                .presentationDetents([.height(PanelLayout.peekHeight), .medium, .large], selection: $detent)
                .presentationBackgroundInteraction(.enabled(upThrough: .medium))
                .presentationDragIndicator(.visible)
                .interactiveDismissDisabled()
        }
    }
}

enum PanelLayout {
    /// The collapsed route panel's height; the map keeps its content above it.
    static let peekHeight: CGFloat = 190
}

/// Floor picker and the 2D / 3D toggle.
struct MapControls: View {
    @Bindable var model: AppModel

    var body: some View {
        HStack(spacing: 8) {
            Picker("Map", selection: $model.mapMode) {
                ForEach(MapMode.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .frame(width: 96)

            Spacer(minLength: 4)

            HStack(spacing: 0) {
                ForEach(model.map.floors.reversed()) { floor in
                    let isSelected = floor.id == model.selectedFloorId
                    let onRoute = model.foundRoute?.legs.contains { $0.floorId == floor.id } ?? false
                    Button {
                        model.selectFloor(floor.id)
                    } label: {
                        VStack(spacing: 2) {
                            Text("L\(floor.level)").font(.subheadline.weight(.semibold))
                            Circle()
                                .fill(onRoute ? Color.blue : Color.clear)
                                .frame(width: 5, height: 5)
                        }
                        .frame(width: 44, height: 40)
                        .foregroundStyle(isSelected ? Color.white : Color.primary)
                        .background(isSelected ? Color.tardyGreen : Color.clear, in: RoundedRectangle(cornerRadius: 9))
                    }
                    .accessibilityLabel("\(floor.displayName)\(onRoute ? ", on your route" : "")")
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                }
            }
            .padding(3)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

struct TappedSpotCard: View {
    let model: AppModel
    let spot: TappedSpot

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: spot.place.map(PlaceIcon.name(for:)) ?? "mappin")
                .foregroundStyle(Color.tardyGreen)
                .font(.title3)
            VStack(alignment: .leading, spacing: 1) {
                Text(spot.place?.title ?? "This spot").font(.headline)
                Text([spot.place?.subtitle, model.floorName(spot.floorId)].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button("Start") { model.startFromTap() }
                .buttonStyle(.bordered)
            if spot.place != nil {
                Button("Go here") { model.goToTap() }
                    .buttonStyle(.borderedProminent)
            }
            Button {
                model.tapped = nil
            } label: {
                Image(systemName: "xmark").font(.footnote.weight(.bold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Dismiss")
        }
        .controlSize(.small)
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
    }
}

struct BannerView: View {
    let text: String
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "location.circle").foregroundStyle(Color.tardyGreen)
            Text(text).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
            Button(action: dismiss) {
                Image(systemName: "xmark").font(.caption.weight(.bold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Dismiss")
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
    }
}

enum PlaceIcon {
    static func name(for node: MapNode) -> String {
        switch node.kind {
        case .entrance: return "door.left.hand.open"
        case .restroom: return "toilet"
        case .elevator: return "arrow.up.arrow.down.square"
        case .stairs: return "figure.stairs"
        default: return "mappin.and.ellipse"
        }
    }
}
