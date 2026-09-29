import { button } from './ui.js';

// Open Project panel: a docked side panel next to Project, not a floating slide-out menu: switching
// projects is a real navigation action with its own list, not a one-off
// pick from a handful of buttons. `projects` is the registry list (each
// `{ id, name, updatedAt }`) minus the one currently open; `onSelect` gets
// one entry when its row is clicked, `onDelete` when its hover-revealed
// delete button is, `onNew` when the "nothing to open yet" fill button is
// (shown only when `projects` is empty: otherwise New already lives in
// the project menu itself, no need to duplicate it here).
//
// Bottom-anchored, same as the Project panel's own file list (.file-list/
// .file-stack: reused here directly, not reinvented): the row stack sits
// at the floor of the scrollable area, and the title comes last in the
// panel itself, so it reads at the very bottom rather than as a header.
export function renderOpenProjectPanel(container, projects, onSelect, onDelete, onNew) {
  container.innerHTML = '';

  const list = document.createElement('div');
  list.className = 'file-list';
  const stack = document.createElement('div');
  stack.className = 'file-stack';

  if (!projects.length) {
    const empty = document.createElement('div');
    empty.className = 'open-project-empty';
    empty.textContent = 'No other projects';
    stack.append(empty);
    stack.append(button({ glyph: '+', fill: true, className: 'panel-add-btn', title: 'New project', onClick: onNew }));
  } else {
    for (const entry of projects) {
      const row = document.createElement('div');
      row.className = 'file-row tile reveal-on-hover';
      row.addEventListener('click', () => onSelect(entry));

      const nameEl = document.createElement('div');
      nameEl.className = 'file-row-name';
      nameEl.textContent = entry.name;

      const deleteBtn = button({
        glyph: '✕', icon: true, className: 'btn--reveal', title: 'Delete project',
        onClick: (e) => { e.stopPropagation(); onDelete(entry); },
      });

      row.append(nameEl, deleteBtn);
      stack.append(row);
    }
  }

  list.append(stack);

  const title = document.createElement('div');
  title.className = 'side-panel-title';
  title.textContent = 'Open Project';

  container.append(list, title);
}
