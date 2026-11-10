import SwiftUI
import TardyCore

/// Search rooms by number ("3335"), name ("Learning Commons") or a term like "restroom".
struct PlacePicker: View {
    let model: AppModel
    let target: PickerTarget
    let onPick: (MapNode) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                if query.trimmingCharacters(in: .whitespaces).isEmpty {
                    browseSections
                } else {
                    let results = model.search(query)
                    if results.isEmpty {
                        ContentUnavailableView.search(text: query)
                    } else {
                        ForEach(results) { row($0) }
                    }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                        prompt: "Room number or name")
            .autocorrectionDisabled()
            .navigationTitle(target == .start ? "Start from" : "Go to")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private var browseSections: some View {
        let places = model.map.places
        let quick = places.filter { $0.kind != .room }
        if !quick.isEmpty {
            Section("Entrances & restrooms") {
                ForEach(quick) { row($0) }
            }
        }
        ForEach(model.map.floors) { floor in
            Section(floor.displayName) {
                ForEach(places.filter { $0.floorId == floor.id && $0.kind == .room }) { row($0) }
            }
        }
    }

    private func row(_ node: MapNode) -> some View {
        Button {
            onPick(node)
            dismiss()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: PlaceIcon.name(for: node))
                    .foregroundStyle(Color.tardyGreen)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 1) {
                    Text(node.title).foregroundStyle(.primary)
                    Text([node.subtitle, model.floorName(node.floorId)].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
