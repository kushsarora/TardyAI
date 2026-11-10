import CoreLocation

/// One-shot "where am I roughly?" for suggesting the start pin.
final class LocationProvider: NSObject, CLLocationManagerDelegate {
    struct Failure: Error {
        var message: String
    }

    private let manager = CLLocationManager()
    private var completion: ((Result<CLLocation, Error>) -> Void)?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    func requestOneFix(_ completion: @escaping (Result<CLLocation, Error>) -> Void) {
        self.completion = completion
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization() // continues in locationManagerDidChangeAuthorization
        case .restricted, .denied:
            finish(.failure(Failure(message: "Location access is off for TardyAI. Turn it on in Settings, or tap the map to set your start.")))
        default:
            manager.requestLocation()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard completion != nil else { return }
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            manager.requestLocation()
        case .restricted, .denied:
            finish(.failure(Failure(message: "Location access is off for TardyAI. Turn it on in Settings, or tap the map to set your start.")))
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if let last = locations.last { finish(.success(last)) }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish(.failure(error))
    }

    private func finish(_ result: Result<CLLocation, Error>) {
        let callback = completion
        completion = nil
        DispatchQueue.main.async { callback?(result) }
    }
}
