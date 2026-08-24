defmodule Grappa.Uploads.MimeExtTest do
  use ExUnit.Case, async: true

  alias Grappa.Uploads.MimeExt
  alias GrappaWeb.UploadsController

  describe "ext_for/1" do
    test "maps each accepted upload MIME to its canonical file extension" do
      expected = %{
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
        # #1764 — text/markdown exists so a .md can be uploaded and READ in
        # the viewer. It is the one MIME this map mints purely for the client.
        "text/markdown" => "md",
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

      for {mime, ext} <- expected do
        assert MimeExt.ext_for(mime) == {:ok, ext},
               "expected #{inspect(mime)} → #{inspect(ext)}, got #{inspect(MimeExt.ext_for(mime))}"
      end
    end

    test "unmapped MIME returns :error (public_url degrades to an extensionless URL)" do
      assert MimeExt.ext_for("application/x-msdownload") == :error
      # SVG is not even in the upload allowlist; it must never mint an ext.
      assert MimeExt.ext_for("image/svg+xml") == :error
    end

    test "non-binary input returns :error" do
      assert MimeExt.ext_for(nil) == :error
      assert MimeExt.ext_for(:image) == :error
    end
  end

  describe "lockstep with the upload MIME allowlist (#418 drift guard)" do
    # Every MIME the controller accepts MUST have a MimeExt mapping, or
    # public_url would mint an extensionless URL for an accepted type and
    # the cic viewer would lose the extension type-signal for it. Adding a
    # MIME to @mime_categories without a MimeExt entry fails HERE, at CI,
    # instead of silently in production — the exact fragility #418 closes.
    test "every UploadsController MIME category key has a MimeExt mapping" do
      for {mime, _} <- UploadsController.mime_categories() do
        assert match?({:ok, _}, MimeExt.ext_for(mime)),
               "MIME #{inspect(mime)} is accepted by UploadsController.mime_categories/0 " <>
                 "but has no Grappa.Uploads.MimeExt.ext_for/1 mapping"
      end
    end
  end
end
