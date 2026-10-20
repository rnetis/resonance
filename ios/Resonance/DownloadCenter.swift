import Combine
import Foundation

/// Owns the server-side download queue: starts jobs, polls them and reports
/// completion so the UI can offer Play / Save offline.
final class DownloadCenter: ObservableObject {
    @Published private(set) var jobs: [Job] = []
    @Published var errorMessage: String?
    @Published var lastCompleted: Job?

    private let api: APIClient
    private var pollTask: Task<Void, Never>?

    init(api: APIClient) {
        self.api = api
    }

    var activeCount: Int {
        jobs.filter(\.isActive).count
    }

    var finishedJobs: [Job] {
        jobs.filter { !$0.isActive }
    }

    func job(forVideoId videoId: String) -> Job? {
        jobs.first { $0.videoId == videoId }
    }

    // MARK: - Actions

    @discardableResult
    func start(videoURL: String, autoPlay: Bool = false) async -> Job? {
        do {
            let job = try await api.startDownload(from: videoURL, autoPlay: autoPlay)
            await MainActor.run {
                self.jobs.removeAll { $0.id == job.id }
                self.jobs.insert(job, at: 0)
                self.errorMessage = nil
            }
            beginPolling()
            return job
        } catch {
            await MainActor.run { self.errorMessage = error.localizedDescription }
            return nil
        }
    }

    func retry(_ job: Job) async {
        await start(videoURL: job.url, autoPlay: job.autoPlay ?? false)
    }

    func cancel(_ job: Job) async {
        do {
            try await api.cancelJob(job.id)
            await refresh()
        } catch {
            await MainActor.run { self.errorMessage = error.localizedDescription }
        }
    }

    func forget(_ job: Job) async {
        do {
            try await api.cancelJob(job.id)
            await MainActor.run { self.jobs.removeAll { $0.id == job.id } }
        } catch {
            await MainActor.run { self.errorMessage = error.localizedDescription }
        }
    }

    func clearFinished() async {
        for job in finishedJobs {
            try? await api.cancelJob(job.id)
        }
        await MainActor.run { self.jobs.removeAll { !$0.isActive } }
    }

    func refresh() async {
        do {
            let page = try await api.jobs()

            await MainActor.run {
                let previous = Dictionary(uniqueKeysWithValues: self.jobs.map { ($0.id, $0) })
                self.jobs = page.jobs
                self.errorMessage = nil

                for job in page.jobs where job.status == "completed" {
                    if let before = previous[job.id], before.isActive {
                        self.lastCompleted = job
                    }
                }
            }
        } catch {
            await MainActor.run { self.errorMessage = error.localizedDescription }
        }
    }

    // MARK: - Polling

    func beginPolling() {
        guard pollTask == nil else { return }

        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()

                let hasActive = await MainActor.run { self.activeCount > 0 }
                let interval: UInt64 = hasActive ? 1_200_000_000 : 5_000_000_000

                try? await Task.sleep(nanoseconds: interval)

                if !hasActive {
                    // Keep a slow heartbeat so a job started elsewhere still shows up.
                    continue
                }
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }
}
