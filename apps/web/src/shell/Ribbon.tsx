import { useState } from 'react';

// PowerPoint-style ribbon. Tab strip + tool groups below.
// The MVP wires Home + Insert with visual-only tool groups; behavior
// follows in P1+ alongside the underlying commands.

const TABS = ['Home', 'Insert', 'Design', 'Transitions', 'Animations', 'Slide Show', 'View'];

interface ToolGroup {
  title: string;
  buttons: { id: string; icon: string; label: string; primary?: boolean; disabled?: boolean }[];
}

const TAB_GROUPS: Record<string, ToolGroup[]> = {
  Home: [
    {
      title: 'Clipboard',
      buttons: [
        { id: 'paste', icon: 'content_paste', label: 'Paste', primary: true },
        { id: 'cut', icon: 'content_cut', label: 'Cut' },
        { id: 'copy', icon: 'content_copy', label: 'Copy' },
      ],
    },
    {
      title: 'Slides',
      buttons: [
        { id: 'new-slide', icon: 'add_to_photos', label: 'New Slide', primary: true },
        { id: 'layout', icon: 'view_compact', label: 'Layout' },
        { id: 'reset', icon: 'restart_alt', label: 'Reset' },
      ],
    },
    {
      title: 'Font',
      buttons: [
        { id: 'bold', icon: 'format_bold', label: 'Bold' },
        { id: 'italic', icon: 'format_italic', label: 'Italic' },
        { id: 'underline', icon: 'format_underlined', label: 'Underline' },
        { id: 'strike', icon: 'strikethrough_s', label: 'Strike' },
        { id: 'color', icon: 'format_color_text', label: 'Color' },
      ],
    },
    {
      title: 'Paragraph',
      buttons: [
        { id: 'left', icon: 'format_align_left', label: 'Left' },
        { id: 'center', icon: 'format_align_center', label: 'Center' },
        { id: 'right', icon: 'format_align_right', label: 'Right' },
        { id: 'bullet', icon: 'format_list_bulleted', label: 'Bullets' },
        { id: 'number', icon: 'format_list_numbered', label: 'Numbered' },
      ],
    },
    {
      title: 'Drawing',
      buttons: [
        { id: 'shape', icon: 'category', label: 'Shapes', primary: true },
        { id: 'arrange', icon: 'flip_to_front', label: 'Arrange' },
        { id: 'quick-style', icon: 'palette', label: 'Quick Styles' },
      ],
    },
  ],
  Insert: [
    {
      title: 'Slides',
      buttons: [{ id: 'new-slide', icon: 'add_to_photos', label: 'New Slide', primary: true }],
    },
    {
      title: 'Tables',
      buttons: [{ id: 'table', icon: 'grid_on', label: 'Table', primary: true, disabled: true }],
    },
    {
      title: 'Images',
      buttons: [
        { id: 'picture', icon: 'image', label: 'Picture', primary: true },
        { id: 'icons', icon: 'emoji_emotions', label: 'Icons', disabled: true },
      ],
    },
    {
      title: 'Illustrations',
      buttons: [
        { id: 'shape', icon: 'category', label: 'Shapes', primary: true },
        { id: 'chart', icon: 'bar_chart', label: 'Chart', disabled: true },
        { id: 'smartart', icon: 'schema', label: 'SmartArt', disabled: true },
      ],
    },
    {
      title: 'Text',
      buttons: [
        { id: 'textbox', icon: 'text_fields', label: 'Text Box', primary: true },
        { id: 'header', icon: 'web_asset', label: 'Header & Footer', disabled: true },
        { id: 'wordart', icon: 'auto_awesome', label: 'WordArt', disabled: true },
      ],
    },
    {
      title: 'Media',
      buttons: [
        { id: 'video', icon: 'movie', label: 'Video', disabled: true },
        { id: 'audio', icon: 'volume_up', label: 'Audio', disabled: true },
      ],
    },
  ],
  Design: [
    { title: 'Themes', buttons: [{ id: 'theme', icon: 'palette', label: 'Themes', primary: true, disabled: true }] },
    { title: 'Variants', buttons: [{ id: 'variants', icon: 'color_lens', label: 'Variants', disabled: true }] },
    { title: 'Customize', buttons: [{ id: 'size', icon: 'aspect_ratio', label: 'Slide Size', disabled: true }] },
  ],
  Transitions: [
    { title: 'Transition', buttons: [{ id: 'fade', icon: 'auto_awesome_motion', label: 'Transitions', primary: true, disabled: true }] },
  ],
  Animations: [
    { title: 'Animation', buttons: [{ id: 'enter', icon: 'star', label: 'Animations', primary: true, disabled: true }] },
  ],
  'Slide Show': [
    { title: 'Start', buttons: [{ id: 'from-start', icon: 'play_arrow', label: 'From Beginning', primary: true, disabled: true }] },
  ],
  View: [
    { title: 'Views', buttons: [
      { id: 'normal', icon: 'view_agenda', label: 'Normal', primary: true },
      { id: 'sorter', icon: 'view_module', label: 'Slide Sorter', disabled: true },
      { id: 'notes', icon: 'sticky_note_2', label: 'Notes Page', disabled: true },
    ] },
  ],
};

export function Ribbon() {
  const [activeTab, setActiveTab] = useState('Home');
  const groups = TAB_GROUPS[activeTab] ?? [];

  return (
    <div className="cs-ribbon">
      <div className="cs-ribbon__tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            type="button"
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            className={`cs-ribbon__tab ${activeTab === tab ? 'is-active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="cs-ribbon__body">
        {groups.map((group) => (
          <div key={group.title} className="cs-ribbon__group">
            <div className="cs-ribbon__group-buttons">
              {group.buttons.map((b) => (
                <button
                  type="button"
                  key={b.id}
                  className={`cs-ribbon__btn ${b.primary ? 'cs-ribbon__btn--primary' : ''}`}
                  disabled={b.disabled}
                  title={b.label}
                >
                  <span className="material-symbols-outlined cs-ribbon__icon">{b.icon}</span>
                  <span className="cs-ribbon__btn-label">{b.label}</span>
                </button>
              ))}
            </div>
            <div className="cs-ribbon__group-title">{group.title}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
