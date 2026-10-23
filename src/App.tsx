import { HashRouter, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Account } from './pages/Account'
import { AlbumPage } from './pages/AlbumPage'
import { Archive } from './pages/Archive'
import { Explore } from './pages/Explore'
import { Home } from './pages/Home'
import { Library } from './pages/Library'
import { PlaylistPage } from './pages/PlaylistPage'
import { SharePage } from './pages/SharePage'
import { Settings } from './pages/Settings'
import { AuthProvider } from './state/AuthContext'
import { PlaylistProvider } from './state/PlaylistContext'
import { PlayerProvider } from './state/PlayerContext'

export default function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <PlaylistProvider>
          <PlayerProvider>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Home />} />
                <Route path="archive" element={<Archive />} />
                <Route path="album/:cid" element={<AlbumPage />} />
                <Route path="library" element={<Library />} />
                <Route path="playlist/:id" element={<PlaylistPage />} />
                <Route path="explore" element={<Explore />} />
                <Route path="share/:code" element={<SharePage />} />
                <Route path="account" element={<Account />} />
                <Route path="settings" element={<Settings />} />
                <Route path="*" element={<Home />} />
              </Route>
            </Routes>
          </PlayerProvider>
        </PlaylistProvider>
      </AuthProvider>
    </HashRouter>
  )
}
