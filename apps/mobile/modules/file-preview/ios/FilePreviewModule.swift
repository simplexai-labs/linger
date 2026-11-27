// Shows a file the phone downloaded in Quick Look, the system viewer for
// PDF, video, Office and iWork documents and more. Native, not a web view.
import ExpoModulesCore
import QuickLook

public class FilePreviewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FilePreview")

    Function("canOpen") { (uri: String) -> Bool in
      guard let url = URL(string: uri), url.isFileURL else { return false }
      return QLPreviewController.canPreview(url as QLPreviewItem)
    }

    AsyncFunction("open") { (uri: String, title: String?, promise: Promise) in
      guard let url = URL(string: uri), url.isFileURL else {
        promise.reject("INVALID_URI", "Only a local file can be shown")
        return
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject("NO_SCREEN", "There is no screen to show the file on")
        return
      }
      let source = PreviewSource(item: PreviewItem(url: url, title: title)) {
        promise.resolve(nil)
      }
      let controller = QLPreviewController()
      controller.dataSource = source
      controller.delegate = source
      // The controller holds its data source weakly; keep it alive with it.
      objc_setAssociatedObject(controller, &PreviewSource.key, source, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
      presenter.present(controller, animated: true)
    }.runOnQueue(.main)
  }
}

final class PreviewItem: NSObject, QLPreviewItem {
  let previewItemURL: URL?
  let previewItemTitle: String?

  init(url: URL, title: String?) {
    previewItemURL = url
    previewItemTitle = title
  }
}

final class PreviewSource: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  static var key = 0
  private let item: PreviewItem
  private let onDismiss: () -> Void

  init(item: PreviewItem, onDismiss: @escaping () -> Void) {
    self.item = item
    self.onDismiss = onDismiss
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    item
  }

  func previewControllerDidDismiss(_ controller: QLPreviewController) {
    onDismiss()
  }
}
