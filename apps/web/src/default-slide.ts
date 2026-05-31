import type { ISlideData } from '@univerjs/slides';
import { PageElementType, PageType } from '@univerjs/slides';

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
  title: 'Untitled presentation',
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
              text: 'Click to add title',
              fs: 60,
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
              text: 'Click to add subtitle',
              fs: 28,
              cl: { rgb: 'rgb(156, 163, 175)' },
            },
          },
        },
      },
    },
  },
};
