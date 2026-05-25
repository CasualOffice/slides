import type { ISlideData } from '@univerjs/slides';
import { PageElementType, PageType } from '@univerjs/slides';

// Minimal default deck for the Spike A bootstrap. Three pages with title +
// body text elements. Replace with a parsed pptx snapshot once PPTX_PIPELINE
// (Spike B) is wired up.
//
// Coordinate system: Univer uses pixels. PageSize 960x540 = 16:9 at 96 DPI.

export const DEFAULT_SLIDE_DATA: ISlideData = {
  id: 'spike-a-deck',
  title: 'Casual Slides — Spike A',
  pageSize: { width: 960, height: 540 },
  body: {
    pageOrder: ['page-1', 'page-2', 'page-3'],
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
              text: 'Casual Slides',
              fs: 60,
              cl: { rgb: 'rgb(17, 24, 39)' },
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
              text: 'PowerPoint-flavored web presentations',
              fs: 28,
              cl: { rgb: 'rgb(75, 85, 99)' },
            },
          },
        },
      },
      'page-2': {
        id: 'page-2',
        pageType: PageType.SLIDE,
        zIndex: 2,
        title: 'Goals',
        description: '',
        pageBackgroundFill: { rgb: 'rgb(255, 255, 255)' },
        pageElements: {
          'el-2-title': {
            id: 'el-2-title',
            zIndex: 1,
            left: 60,
            top: 60,
            width: 840,
            height: 60,
            title: 'title',
            description: '',
            type: PageElementType.TEXT,
            richText: {
              text: 'P0 Spike A — bootstrap',
              fs: 40,
              cl: { rgb: 'rgb(17, 24, 39)' },
              bl: 1,
            },
          },
          'el-2-body': {
            id: 'el-2-body',
            zIndex: 2,
            left: 60,
            top: 160,
            width: 840,
            height: 340,
            title: 'body',
            description: '',
            type: PageElementType.TEXT,
            richText: {
              text: '• Mount @univerjs/slides + slides-ui via pnpm overrides to the fork\n• Hide native chrome\n• Render a default deck\n• Confirm Univer DI + plugin lifecycle run cleanly',
              fs: 22,
              cl: { rgb: 'rgb(31, 41, 55)' },
            },
          },
        },
      },
      'page-3': {
        id: 'page-3',
        pageType: PageType.SLIDE,
        zIndex: 3,
        title: 'Next',
        description: '',
        pageBackgroundFill: { rgb: 'rgb(255, 255, 255)' },
        pageElements: {
          'el-3-title': {
            id: 'el-3-title',
            zIndex: 1,
            left: 60,
            top: 60,
            width: 840,
            height: 60,
            title: 'title',
            description: '',
            type: PageElementType.TEXT,
            richText: {
              text: 'Next: Spike B (pptx round-trip) and Spike C (collab patch)',
              fs: 32,
              cl: { rgb: 'rgb(17, 24, 39)' },
              bl: 1,
            },
          },
        },
      },
    },
  },
};
