defmodule Grappa.Uploads.MimeExt do
  @moduledoc """
  MIME → canonical file-extension map — the single source of truth for
  the extension appended to an upload's public URL (#418).

  ## Why this exists

  `UploadsController.public_url/2` mints `/uploads/<slug>.<ext>` so the
  URL itself carries the media type. Before #418 the URL was
  extensionless and the cic viewer sniffed a 📸/🎬/🎵 emoji prefix out of
  the message body to guess the type — fragile: any copy / locale / relay
  / alias-expansion change to how the message is composed severed the
  signal silently and the viewer guessed wrong. The extension makes the
  type intrinsic to the URL; the emoji stays only as a legacy fallback
  for links already in scrollback.

  ## Contract

  `ext_for/1` returns `{:ok, ext}` (extension, no leading dot) for every
  MIME in the `GrappaWeb.UploadsController` accept-allowlist — pinned by a
  lockstep test — or `:error` for anything else. `public_url/2` degrades
  an unmapped MIME to an extensionless URL (today's behaviour), never
  crashes.

  This is a DEDICATED map, NOT `Grappa.Uploads.MetadataStrip`'s
  `@exiftool_exts`: that one means "extensions exiftool can strip"
  (image/video only) — a different domain. Widening it to audio/docs
  would fork one map across two meanings (the shared-structure-with-a-
  flag boundary violation CLAUDE.md rejects).

  ## Cross-language contract (drift warning)

  Every extension this map can mint for a VIEWER-RELEVANT type
  (image / video / audio) MUST be classified by cic's `EXTENSION_KIND`
  (`cicchetto/src/lib/mediaLink.ts`) — otherwise a fresh upload loses its
  in-app media viewer on the client. Pinned on the cic side by
  `mediaLink.test.ts` ("server-mintable viewer extensions"). Document
  types (pdf/txt/odt/ods/docx/xlsx) are deliberately NOT viewer-relevant
  and need no cic entry.
  """

  # Keep in lockstep with `GrappaWeb.UploadsController` @mime_categories
  # (the accept-allowlist) — the MimeExtTest lockstep fails CI if a MIME
  # is added there without an extension here. Synonym MIMEs collapse to
  # one canonical extension (x-m4a→m4a; x-wav/wave→wav; x-flac→flac).
  @mime_ext %{
    "image/png" => "png",
    "image/jpeg" => "jpg",
    "image/gif" => "gif",
    "image/webp" => "webp",
    "image/apng" => "apng",
    "video/mp4" => "mp4",
    "video/quicktime" => "mov",
    "video/webm" => "webm",
    "application/pdf" => "pdf",
    "text/plain" => "txt",
    "application/vnd.oasis.opendocument.text" => "odt",
    "application/vnd.oasis.opendocument.spreadsheet" => "ods",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
    "audio/mpeg" => "mp3",
    "audio/mp4" => "m4a",
    "audio/x-m4a" => "m4a",
    "audio/aac" => "aac",
    "audio/wav" => "wav",
    "audio/x-wav" => "wav",
    "audio/wave" => "wav",
    "audio/flac" => "flac",
    "audio/x-flac" => "flac"
  }

  @doc """
  The canonical file extension (no leading dot) for an accepted upload
  MIME as `{:ok, ext}`, or `:error` for an unmapped / non-binary input.
  """
  @spec ext_for(term()) :: {:ok, String.t()} | :error
  def ext_for(mime) when is_binary(mime), do: Map.fetch(@mime_ext, mime)
  def ext_for(_), do: :error
end
