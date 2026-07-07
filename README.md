# Steam Collection Manager
A utility to manage large steam libraries.  Front End Launcher. Collections Manager.<br><br>
This is alpha software expect bugs.  If you have already spent a tremendous amount of effort working on collections manually or otherwise this tool may not be for you, or maybe it is!? I just say this to warn that this tool WILL modify your collections so please don't be angry at me if you don't head this warning now and it ends up undoing something you've already spent a lot time working on :)

<h1>Installation</h1>
From cmd/terminal/powershell<br/><br/>

```
git clone https://github.com/undertow1984/SteamCollectionManager.git
cd SteamCollectionManager
npm install
```

<h1>Start Application as Web App</h1>
Navigate to folder and run<br/>

```
npm start
```
open browser and navigate to http://localhost:3000<br/>

<h1>Start Application as executable</h1>
Navigate to folder and run<br/>

```
npm run electron
```

<h1>Build Installer / Exe</h1>
Navigate to folder and run<br/>

```
npm run build
```
You should now see a dist folder which will have a standalone windows binary under win_extract and a windows installer<br/>

<h1>Known Issues</h1>
<h3>Some games may be missing from steam.</h3>
I'm still debugging this issue but there is a bizarre issue where steam imports in a lot of different categories and application types so depending on the size of your library you may be missing none or as in my case having over 3,000 games I seem to be missing around 30 or so titles.

<h3>Previously "removed from library" games or "refunded" games may be appearing</h3>
I've included a check for license hack where the vast majority of these items will not appear but the hack includes attempting to pull trophies which require a license to do.  In any case something that was removed was free or you have some type of ownership still these items may appear even though you don't see them in steam.

<h3>Controller support is there and works but sometimes can be wonky in navigation - I'm still working out all the kinks.</h3>
