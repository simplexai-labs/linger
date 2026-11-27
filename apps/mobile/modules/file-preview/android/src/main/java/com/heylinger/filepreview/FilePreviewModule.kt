// Hands a file the phone downloaded to the app the system picks for its type,
// through a content URI that grants read access to that one file.
package com.heylinger.filepreview

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class FilePreviewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("FilePreview")

    Function("canOpen") { uri: String ->
      Uri.parse(uri).scheme == "file"
    }

    AsyncFunction("open") { uri: String, title: String?, mediaType: String? ->
      val context = appContext.reactContext ?: throw CodedException("NO_SCREEN", "There is no screen to show the file on", null)
      val path = Uri.parse(uri).path ?: throw CodedException("INVALID_URI", "Only a local file can be shown", null)
      val content = FileProvider.getUriForFile(context, "${context.packageName}.filepreview", File(path))
      val view = Intent(Intent.ACTION_VIEW)
        .setDataAndType(content, mediaType ?: "*/*")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      val chooser = Intent.createChooser(view, title)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      try {
        context.startActivity(chooser)
      } catch (error: ActivityNotFoundException) {
        throw CodedException("NO_VIEWER", "No app on this phone opens this file", error)
      }
    }
  }
}
