# SteamCollectionManager

A beautiful, feature-rich desktop and web-based tool for organizing, browsing, filtering, and launching your Steam library using custom folders and collections. Includes deep metadata integration (HLTB, Metacritic, Steam reviews), powerful filters, multi-select, quick-move, and excellent controller support.

![SteamCollectionManager](https://github.com/user-attachments/assets/placeholder-screenshot) <!-- Replace with actual screenshots when available -->

## ✨ Features

- **Custom Folders & Collections**
  - Create static folders and dynamic (rule-based) collections
  - Move games between folders easily via drag & drop, sidecar, or game options
  - "All Games", "Uncategorized", and user-created folders
  - Optional support for games belonging to multiple folders (like tags)

- **Rich Game Metadata**
  - Steam artwork, playtime, and details
  - Metacritic scores (with fallback)
  - HowLongToBeat (HLTB) playtimes
  - Steam review scores and counts
  - Tags, genres, controller support, VR flags, release year
  - Screenshots and trailers from the Steam Store

- **Advanced Browsing**
  - Grid and List views
  - Powerful filters (Installed, VR, Controller, Metacritic ranges, Reviews, HLTB, Tags, Genres)
  - Sorting and Grouping options
  - Full-text search
  - Multi-select mode

- **Quick Actions**
  - Quick Move sidecar panel (RT on controller or click icon)
  - One-click launch / uninstall
  - Export collections to Steam

- **Excellent Controller Support**
  - Full gamepad navigation (A/B/X/Y, bumpers, triggers, sticks, D-pad)
  - Virtual on-screen keyboard for text input
  - Dedicated Back button shortcut for folder switching
  - Clear, documented button mappings

- **Desktop + Web**
  - Polished Electron desktop app (Windows) with tray support
  - Run as a web app (`node server.mjs`) for browser access
  - Automatic data persistence in user data folder (packaged) or project folder

- **Smart Caching & Refresh**
  - Background scraping/caching for scores and playtimes
  - Manual refresh buttons for missing or all data in Settings
  - Only runs expensive scans when needed (or on new games)

## 📸 Screenshots

Add screenshots here once you have them:

- Main grid view with folders
- Filters and search in action
- Game details modal (with videos/screenshots)
- Controller help screen
- Quick Move sidecar

## 🚀 Installation

### Desktop App (Recommended for most users)

1. Download the latest `SteamCollectionManager Setup.exe` from the [Releases](https://github.com/YOUR_USERNAME/steam-collection-manager/releases) page.
2. Run the installer.
3. Launch **SteamCollectionManager** from the Start Menu or Desktop.

### From Source / Web Version

**Requirements**
- Node.js 18+
- A Steam Web API Key
- Your Steam ID64

```bash
git clone https://github.com/YOUR_USERNAME/steam-collection-manager.git
cd steam-collection-manager
npm install

# Run as web server
npm start

# Or run the Electron desktop app
npm run electron
```

Open http://localhost:3000 (or your configured port) in a browser.

## ⚙️ First-Time Setup

1. Click the **Settings** (gear) icon or the big **Setup Credentials** button.
2. Get a free **Steam Web API Key** here: [https://steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey)
3. Find your **SteamID64** (use [steamid.io](https://steamid.io) or check your profile URL).
4. Paste both into the settings and save.
5. Click **Refresh** (circular arrow) to load your library.

**Important**: Your Steam profile must be set to **Public** (especially "Game details").

## 🎮 Controller Support

SteamCollectionManager has first-class controller support.

| Button              | Action |
|---------------------|--------|
| **A (South)**       | Activate / Select. Open game options. Confirm in modals. Long-press on card = multi-select. |
| **B (East)**        | Cancel / Back / Close. Clear search when appropriate. |
| **X (West)**        | Toggle between game grid and top header (search, folder dropdown, buttons). |
| **Y (North)**       | Toggle Filters panel. |
| **LB**              | Open/focus left sidebar (folders). |
| **RB**              | Open/focus right Quick Move panel. |
| **LT**              | Multi-select modifier (with A). |
| **RT**              | Quick Move the focused game. |
| **Back / Select**   | Instantly open the Change Folder dialog. |
| **Left Stick / D-Pad** | Navigate. |
| **Right Stick**     | Scroll. |

When a text field is focused, press **A** to open the virtual keyboard.

Full mappings are also available in-app via the **?** (Help) button.

## 🛠️ Building from Source

```bash
npm install
npm run build   # Creates Windows installer in /dist
```

The build uses `electron-builder`. Output is an NSIS installer.

## 📁 Data & Privacy

- All data (folders, caches, config) is stored **locally**.
- Your Steam API key and library data never leave your machine except for official Steam/HLTB API calls.
- Caches can be cleared from the Settings screen.

## 🤝 Contributing

Contributions are welcome! Feel free to open issues or pull requests for:

- New filters or metadata sources
- UI/UX improvements
- Better controller mappings
- Bug fixes

## 📄 License

This project is provided as-is for personal use. Check individual files for any third-party licenses.

---

Made with ❤️ for Steam users who love organizing their libraries.

**SteamCollectionManager** — Because your games deserve better than one giant list.
