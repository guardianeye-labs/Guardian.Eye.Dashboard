const ICON_SET = "guardian-eye";

const icons = {
  logo: {
    path: "M12 1 21 4v6c0 6.2-3.8 10.7-9 13-5.2-2.3-9-6.8-9-13V4l9-3Zm6 9a6 6 0 1 0-12 0 6 6 0 1 0 12 0Zm-3.8 0a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 1 1 4.4 0Z",
    viewBox: "0 0 24 24",
  },
};

async function getIcon(name) {
  return icons[name] ?? icons.logo;
}

async function getIconList() {
  return Object.keys(icons).map((name) => ({ name, keywords: [] }));
}

window.customIconsets = window.customIconsets || {};
window.customIconsets[ICON_SET] = getIcon;
window.customIcons = window.customIcons || {};
window.customIcons[ICON_SET] = { getIcon, getIconList };
