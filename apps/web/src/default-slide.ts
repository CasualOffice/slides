import type { ISlideData } from '@univerjs/slides';
import { PageElementType, PageType } from '@univerjs/slides';
import { appLocale } from './i18n';

// PowerPoint-style localized deck title + placeholder prompts. Keyed by the
// app's active locale (resolved synchronously before React mounts). Exported
// so LayoutPicker templates (shell/layouts.ts) share one source of truth.
type DeckStrKey = 'deckTitle' | 'addTitle' | 'addSubtitle' | 'addContent';
const DECK_STRINGS: Record<DeckStrKey, Record<string, string>> = {
  deckTitle: {
    en: 'Untitled presentation', ja: '無題のプレゼンテーション',
    'zh-cn': '无标题演示文稿', 'zh-tw': '未命名簡報',
    fr: 'Présentation sans titre', es: 'Presentación sin título',
  },
  addTitle: {
    en: 'Click to add title', ja: 'タイトルを入力',
    'zh-cn': '单击此处添加标题', 'zh-tw': '按一下以新增標題',
    fr: 'Cliquez pour ajouter un titre', es: 'Haz clic para agregar un título',
  },
  addSubtitle: {
    en: 'Click to add subtitle', ja: 'サブタイトルを入力',
    'zh-cn': '单击此处添加副标题', 'zh-tw': '按一下以新增副標題',
    fr: 'Cliquez pour ajouter un sous-titre', es: 'Haz clic para agregar un subtítulo',
  },
  addContent: {
    en: 'Click to add content', ja: 'コンテンツを入力',
    'zh-cn': '单击此处添加内容', 'zh-tw': '按一下以新增內容',
    fr: 'Cliquez pour ajouter du contenu', es: 'Haz clic para agregar contenido',
  },
};

export function deckString(key: DeckStrKey): string {
  const table = DECK_STRINGS[key];
  return table[appLocale] ?? table.en ?? '';
}

// Single blank starting slide — matches the "open the app, see one
// empty title slide" defaults of Google Slides and PowerPoint Online.
// The 3-slide Spike A debug deck this replaced was leaking alpha-era
// branding into the v0.1.0 cold-boot impression. See UX_AUDIT_v0.1.0
// item S4.
//
// Coordinate system: Univer uses pixels. PageSize 960x540 = 16:9 at 96 DPI.
// Empty richText.text means the placeholder reads as visually blank; users
// click to start typing — same affordance Google Slides / PowerPoint Online
// expose on a fresh deck.

export const DEFAULT_SLIDE_DATA: ISlideData = {
  id: 'untitled-deck',
  title: deckString('deckTitle'),
  pageSize: { width: 960, height: 540 },
  body: {
    pageOrder: ['page-1'],
    pages: {
      'page-1': {
        id: 'page-1',
        pageType: PageType.SLIDE,
        zIndex: 1,
        title: 'Title slide',
        description: '',
        pageBackgroundFill: { rgb: 'rgb(255, 255, 255)' },
        pageElements: {
          'el-1-title': {
            id: 'el-1-title',
            zIndex: 1,
            left: 80,
            top: 180,
            width: 800,
            height: 100,
            title: 'title',
            description: '',
            type: PageElementType.TEXT,
            richText: {
              text: deckString('addTitle'),
              fs: 60,
              ff: 'Calibri',
              cl: { rgb: 'rgb(156, 163, 175)' },
              bl: 1,
            },
          },
          'el-1-subtitle': {
            id: 'el-1-subtitle',
            zIndex: 2,
            left: 80,
            top: 300,
            width: 800,
            height: 60,
            title: 'subtitle',
            description: '',
            type: PageElementType.TEXT,
            richText: {
              text: deckString('addSubtitle'),
              fs: 28,
              ff: 'Calibri',
              cl: { rgb: 'rgb(156, 163, 175)' },
            },
          },
        },
      },
    },
  },
};
