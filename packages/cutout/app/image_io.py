"""Bounded image decoding/normalization shared by the job manager and tests."""
from __future__ import annotations

import warnings
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from .settings import Settings


class ImageInputError(ValueError):
    """The submitted bytes are not an acceptable item-photo draft."""


def normalize_image(data: bytes, content_type: str, target: Path, settings: Settings) -> tuple[int, int]:
    formats = {"image/webp": "WEBP", "image/jpeg": "JPEG", "image/png": "PNG"}
    expected = formats.get(content_type.split(";", 1)[0].strip().lower())
    if expected is None:
        raise ImageInputError("请选择已压缩的 JPEG、PNG 或 WebP 图片后再抠图。")
    if not data:
        raise ImageInputError("图片内容为空。")
    if len(data) > settings.max_input_bytes:
        raise ImageInputError("压缩后的图片不能超过 2 MiB，请重新选择照片。")

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data), formats=[expected]) as opened:
                if opened.format != expected:
                    raise ImageInputError("图片内容与声明的格式不匹配。")
                width, height = opened.size
                if width < 1 or height < 1 or width * height > settings.max_source_pixels:
                    raise ImageInputError("图片尺寸不能超过 4000 万像素。")
                opened.load()
                normalized = ImageOps.exif_transpose(opened).convert("RGBA")
    except ImageInputError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise ImageInputError("图片无法读取，请重新选择 JPG、PNG 或 WebP 图片。") from error

    normalized.thumbnail((settings.max_edge, settings.max_edge), Image.Resampling.LANCZOS)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    normalized.save(target, format="PNG", optimize=True)
    normalized.close()
    with Image.open(target) as saved:
        return saved.width, saved.height
