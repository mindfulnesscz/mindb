import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from './context/AuthContext'
import { RoleProvider } from './context/RoleContext'
import { queryClient } from './lib/queryClient'
import './styles/globals.css'
import App from './App'

/* The query cache sits OUTSIDE the router, so a navigation cannot unmount it — that is the whole
   point of it: Back and Forward render from cache rather than re-querying. */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <RoleProvider>
            <App />
          </RoleProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
