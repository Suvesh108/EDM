export type FileCategory = 
  | 'VIDEO'
  | 'AUDIO'
  | 'PHOTO'
  | 'ZIP'
  | 'DOCUMENT'
  | 'SPREADSHEET'
  | 'PRESENTATION'
  | 'EBOOK'
  | 'TEXT';

export interface CategorySpec {
  category: FileCategory;
  targetExtension: string;
  mimeType: string;
  label: string;
  badgeColor: string;
  description: string;
}

export const CATEGORY_SPECS: Record<FileCategory, CategorySpec> = {
  VIDEO: {
    category: 'VIDEO',
    targetExtension: 'mp4',
    mimeType: 'video/mp4',
    label: 'Video Stream',
    badgeColor: 'bg-red-500/20 text-red-400 border-red-500/30',
    description: 'Converted & multiplexed to standard H.264/AAC .mp4'
  },
  AUDIO: {
    category: 'AUDIO',
    targetExtension: 'm4a',
    mimeType: 'audio/mp4',
    label: 'Audio Track',
    badgeColor: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    description: 'Transcoded & packaged to high-bitrate AAC .m4a'
  },
  PHOTO: {
    category: 'PHOTO',
    targetExtension: 'jpg',
    mimeType: 'image/jpeg',
    label: 'Photo / Image',
    badgeColor: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    description: 'Normalized to standard JPEG .jpg image'
  },
  ZIP: {
    category: 'ZIP',
    targetExtension: 'zip',
    mimeType: 'application/zip',
    label: 'Archive Package',
    badgeColor: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    description: 'Streamed & preserved as .zip archive'
  },
  DOCUMENT: {
    category: 'DOCUMENT',
    targetExtension: 'pdf',
    mimeType: 'application/pdf',
    label: 'PDF Document',
    badgeColor: 'bg-rose-500/20 text-rose-400 border-rose-500/30',
    description: 'Direct document formatted as .pdf'
  },
  SPREADSHEET: {
    category: 'SPREADSHEET',
    targetExtension: 'xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'Spreadsheet',
    badgeColor: 'bg-green-500/20 text-green-400 border-green-500/30',
    description: 'Tabular dataset structured as Excel .xlsx'
  },
  PRESENTATION: {
    category: 'PRESENTATION',
    targetExtension: 'pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    label: 'Presentation Slide',
    badgeColor: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
    description: 'Presentation deck compiled as PowerPoint .pptx'
  },
  EBOOK: {
    category: 'EBOOK',
    targetExtension: 'epub',
    mimeType: 'application/epub+zip',
    label: 'E-Book Publication',
    badgeColor: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    description: 'Electronic publication formatted as .epub'
  },
  TEXT: {
    category: 'TEXT',
    targetExtension: 'txt',
    mimeType: 'text/plain',
    label: 'Plain Text File',
    badgeColor: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
    description: 'Standard UTF-8 plain text document .txt'
  }
};

/**
 * Automatically detects the file category and target extension from any URL
 */
export function detectFileCategory(url: string): CategorySpec {
  const cleanUrl = url.trim().toLowerCase();

  // 1. Platform signature detection
  if (
    cleanUrl.includes('youtube.com') ||
    cleanUrl.includes('youtu.be') ||
    cleanUrl.includes('tiktok.com') ||
    cleanUrl.includes('instagram.com') ||
    cleanUrl.includes('twitter.com') ||
    cleanUrl.includes('x.com') ||
    cleanUrl.includes('vimeo.com') ||
    cleanUrl.includes('dailymotion.com') ||
    cleanUrl.includes('twitch.tv') ||
    cleanUrl.includes('reddit.com/r/') ||
    cleanUrl.includes('facebook.com') ||
    cleanUrl.includes('fb.watch')
  ) {
    return CATEGORY_SPECS.VIDEO;
  }

  if (
    cleanUrl.includes('soundcloud.com') ||
    cleanUrl.includes('bandcamp.com') ||
    cleanUrl.includes('spotify.com') ||
    cleanUrl.includes('mixcloud.com') ||
    cleanUrl.includes('audiomack.com')
  ) {
    return CATEGORY_SPECS.AUDIO;
  }

  if (
    cleanUrl.includes('pinterest.com') ||
    cleanUrl.includes('pin.it') ||
    cleanUrl.includes('imgur.com') ||
    cleanUrl.includes('flickr.com') ||
    cleanUrl.includes('deviantart.com') ||
    cleanUrl.includes('unsplash.com') ||
    cleanUrl.includes('pexels.com')
  ) {
    return CATEGORY_SPECS.PHOTO;
  }

  // 2. Direct File Extension Pattern Matching
  const urlPath = cleanUrl.split('?')[0].split('#')[0];

  // Video extensions → VIDEO (.mp4)
  if (/\.(mp4|mkv|webm|avi|mov|flv|wmv|m4v|3gp|ts|m3u8)$/i.test(urlPath)) {
    return CATEGORY_SPECS.VIDEO;
  }

  // Audio extensions → AUDIO (.m4a)
  if (/\.(m4a|mp3|wav|aac|flac|ogg|opus|wma|aiff|alac)$/i.test(urlPath)) {
    return CATEGORY_SPECS.AUDIO;
  }

  // Photo extensions → PHOTO (.jpg)
  if (/\.(jpg|jpeg|png|webp|bmp|svg|gif|heic|tiff|ico|avif)$/i.test(urlPath)) {
    return CATEGORY_SPECS.PHOTO;
  }

  // Zip / Archive extensions → ZIP (.zip)
  if (/\.(zip|rar|7z|tar|gz|bz2|xz|iso|tgz|zst|apk)$/i.test(urlPath)) {
    return CATEGORY_SPECS.ZIP;
  }

  // Document extensions → DOCUMENT (.pdf)
  if (/\.(pdf|doc|docx|rtf|odt|pages|wps)$/i.test(urlPath)) {
    return CATEGORY_SPECS.DOCUMENT;
  }

  // Spreadsheet extensions → SPREADSHEET (.xlsx)
  if (/\.(xlsx|xls|csv|tsv|ods|numbers)$/i.test(urlPath)) {
    return CATEGORY_SPECS.SPREADSHEET;
  }

  // Presentation extensions → PRESENTATION (.pptx)
  if (/\.(pptx|ppt|odp|key|pps|ppsx)$/i.test(urlPath)) {
    return CATEGORY_SPECS.PRESENTATION;
  }

  // Ebook extensions → EBOOK (.epub)
  if (/\.(epub|mobi|azw3|azw|fb2|ibooks|cbz|cbr)$/i.test(urlPath)) {
    return CATEGORY_SPECS.EBOOK;
  }

  // Text extensions → TEXT (.txt)
  if (/\.(txt|log|md|json|xml|html|htm|yaml|yml|ini|cfg|env)$/i.test(urlPath)) {
    return CATEGORY_SPECS.TEXT;
  }

  // Default to VIDEO for general media links
  return CATEGORY_SPECS.VIDEO;
}
