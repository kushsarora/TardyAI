import SwiftUI
import TardyCore

/// What the place picker is choosing.
enum PickerTarget: String, Identifiable {
    case start, destination
    var id: String { rawValue }
}

/// The bottom sheet: endpoints, options, the "am I late?" card and directions.
struct RoutePanel: View {
    @Bindable var model: AppModel
    @Binding var detent: PresentationDetent
    @State private var picking: PickerTarget?

    var body: some View {
        NavigationStack {
            List {
                endpointsSection
                if let route = model.foundRoute {
                    summarySection(route)
                    if let active = model.activeLegIndex, route.legs.indices.contains(active) {
                        activeLegSection(route, index: active)
                    } else {
                        directionsSections(route)
                    }
                } else if let message = model.route?.message {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    }
                }
                optionsSection
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(.compact)
            .navigationTitle(model.map.building.name)
            .navigationBarTitleDisplayMode(.inline)
        }
        .sheet(item: $picking) { target in
            PlacePicker(model: model, target: target) { node in
                switch target {
                case .start: model.setStart(node.id)
                case .destination: model.setDestination(node.id)
                }
                detent = .medium
            }
        }
    }

    // MARK: Sections

    private var endpointsSection: some View {
        Section {
            EndpointRow(symbol: "figure.walk.circle.fill", tint: .green, caption: "From",
                        value: model.startNode == nil ? "Choose a start" : model.label(model.startNode)) { picking = .start }
            EndpointRow(symbol: "flag.circle.fill", tint: .red, caption: "To",
                        value: model.destNode == nil ? "Where’s your class?" : model.label(model.destNode),
                        isPlaceholder: model.destNode == nil) { picking = .destination }
            if model.destNode != nil {
                HStack {
                    Button { model.swapEndpoints() } label: {
                        Label("Swap", systemImage: "arrow.up.arrow.down")
                    }
                    Spacer()
                    Button(role: .destructive) { model.clearRoute() } label: {
                        Label("Clear", systemImage: "xmark.circle")
                    }
                }
                .buttonStyle(.borderless)
                .font(.subheadline)
            }
        }
    }

    private func summarySection(_ route: NavRoute) -> some View {
        Section {
            HStack(alignment: .firstTextBaseline) {
                Text(ArrivalEstimator.durationText(seconds: route.totalSeconds))
                    .font(.title2.weight(.bold))
                Text("walk · \(Int(route.totalMeters.rounded())) m")
                    .foregroundStyle(.secondary)
                Spacer()
                if route.floorsTraversed > 1 {
                    Label("\(route.floorsTraversed) floors", systemImage: "square.stack.3d.up")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            ArrivalCard(routeSeconds: route.totalSeconds)
            if model.activeLegIndex == nil {
                Button {
                    model.startDirections()
                } label: {
                    Label("Start directions", systemImage: "location.north.line.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            }
        }
    }

    private func directionsSections(_ route: NavRoute) -> some View {
        ForEach(Array(route.legs.enumerated()), id: \.offset) { index, leg in
            Section {
                ForEach(Array(leg.steps.enumerated()), id: \.offset) { _, step in
                    StepRow(step: step)
                }
            } header: {
                Button {
                    model.selectFloor(leg.floorId)
                } label: {
                    HStack {
                        Text(model.floorName(leg.floorId))
                        Spacer()
                        Text("Show on map").font(.caption)
                    }
                }
            }
        }
    }

    private func activeLegSection(_ route: NavRoute, index: Int) -> some View {
        let leg = route.legs[index]
        return Section {
            Text(leg.instruction).font(.headline)
            ForEach(Array(leg.steps.enumerated()), id: \.offset) { _, step in
                StepRow(step: step)
            }
            HStack {
                Button {
                    model.showLeg(index - 1)
                } label: { Label("Back", systemImage: "chevron.left") }
                    .disabled(index == 0)
                Spacer()
                if index < route.legs.count - 1 {
                    Button {
                        model.showLeg(index + 1)
                    } label: { Label("Next floor", systemImage: "chevron.right") }
                        .buttonStyle(.borderedProminent)
                } else {
                    Button("Done") { model.endDirections() }
                        .buttonStyle(.borderedProminent)
                }
            }
            .buttonStyle(.bordered)
        } header: {
            Text("\(model.floorName(leg.floorId)) · Part \(index + 1) of \(route.legs.count)")
        } footer: {
            Text("Directions follow the map, not your phone’s position. Tap Next when you’ve changed floors.")
        }
    }

    private var optionsSection: some View {
        Section {
            Toggle(isOn: Binding(get: { model.stepFree }, set: { model.setStepFree($0) })) {
                Label("Step-free (elevators only)", systemImage: "figure.roll")
            }
            Button {
                model.useMyLocation()
            } label: {
                HStack {
                    Label("Start from my location", systemImage: "location")
                    if model.isLocating {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(model.isLocating)
        } footer: {
            Text("Tip: tap the floor plan to start from, or go to, any room. GPS suggests a spot on the floor you’ve picked; it can’t tell floors apart.")
        }
    }
}

private struct EndpointRow: View {
    let symbol: String
    let tint: Color
    let caption: String
    let value: String
    var isPlaceholder = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: symbol)
                    .font(.title2)
                    .foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 1) {
                    Text(caption).font(.caption).foregroundStyle(.secondary)
                    Text(value)
                        .foregroundStyle(isPlaceholder ? .secondary : .primary)
                        .lineLimit(1)
                }
                Spacer()
                Image(systemName: "magnifyingglass").foregroundStyle(.tertiary)
            }
        }
        .accessibilityLabel("\(caption): \(value)")
    }
}

private struct StepRow: View {
    let step: RouteStep

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .frame(width: 24)
                .foregroundStyle(step.kind == .connector ? Color.orange : Color.tardyGreen)
            Text(step.text)
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var symbol: String {
        switch step.kind {
        case .start: return "figure.walk"
        case .straight: return "arrow.up"
        case .connector: return "arrow.up.arrow.down"
        case .arrive: return "flag.checkered"
        case .turn:
            switch step.turn {
            case .left: return "arrow.turn.up.left"
            case .right: return "arrow.turn.up.right"
            case .around: return "arrow.uturn.down"
            default: return "arrow.up"
            }
        }
    }
}
