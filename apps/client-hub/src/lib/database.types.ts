export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export interface Database {
  public: {
    Tables: {
      clients: {
        Row: {
          id: string
          name: string
          slug: string | null
          accent: string
          initials: string
          logo_url: string | null
          website: string | null
          portal_bg: string | null
          domain_whitelist: string[]
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          slug?: string | null
          accent?: string
          initials?: string
          logo_url?: string | null
          website?: string | null
          portal_bg?: string | null
          domain_whitelist?: string[]
          created_at?: string
        }
        Update: {
          name?: string
          slug?: string | null
          accent?: string
          initials?: string
          logo_url?: string | null
          website?: string | null
          portal_bg?: string | null
          domain_whitelist?: string[]
        }
      }
      profiles: {
        Row: {
          id: string
          name: string
          initials: string
          role: 'public' | 'member' | 'editor' | 'admin'
          client_id: string | null
          company: string
          country: string
          industry: string
          created_at: string
        }
        Insert: {
          id: string
          name: string
          initials?: string
          role?: 'public' | 'member' | 'editor' | 'admin'
          client_id?: string | null
          company?: string
          country?: string
          industry?: string
          created_at?: string
        }
        Update: {
          name?: string
          initials?: string
          role?: 'public' | 'member' | 'editor' | 'admin'
          client_id?: string | null
          company?: string
          country?: string
          industry?: string
        }
      }
      tags: {
        Row: {
          id: string
          client_id: string | null
          name: string
          dimension: 'entity' | 'format' | 'angle'
          parent_id: string | null
          sort_order: number
          created_at: string
        }
        Insert: {
          id?: string
          client_id?: string | null
          name: string
          dimension: 'entity' | 'format' | 'angle'
          parent_id?: string | null
          sort_order?: number
          created_at?: string
        }
        Update: {
          client_id?: string | null
          name?: string
          dimension?: 'entity' | 'format' | 'angle'
          parent_id?: string | null
          sort_order?: number
        }
      }
      assets: {
        Row: {
          id: string
          client_id: string
          shortcode: string
          name: string
          entities: string[]
          formats: string[]
          angles: string[]
          tags: string[]
          status: 'draft' | 'review' | 'approved' | 'published' | 'archived' | 'disconnected'
          perm: 'public' | 'client' | 'internal'
          version: string
          latest: boolean
          thumbnail_url: string | null
          download_url: string | null
          download_urls: Json
          download_key: string | null
          parent_id: string | null
          variant_of: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          client_id: string
          shortcode: string
          name: string
          entities?: string[]
          formats?: string[]
          angles?: string[]
          tags?: string[]
          status?: 'draft' | 'review' | 'approved' | 'published' | 'archived' | 'disconnected'
          perm?: 'public' | 'client' | 'internal'
          version?: string
          latest?: boolean
          thumbnail_url?: string | null
          download_url?: string | null
          download_urls?: Json
          download_key?: string | null
          parent_id?: string | null
          variant_of?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          shortcode?: string
          name?: string
          entities?: string[]
          formats?: string[]
          angles?: string[]
          tags?: string[]
          status?: 'draft' | 'review' | 'approved' | 'published' | 'archived' | 'disconnected'
          perm?: 'public' | 'client' | 'internal'
          version?: string
          latest?: boolean
          thumbnail_url?: string | null
          download_url?: string | null
          download_urls?: Json
          download_key?: string | null
          parent_id?: string | null
          variant_of?: string | null
        }
      }
      ratings: {
        Row: {
          id: string
          asset_id: string
          user_id: string
          value: number
          created_at: string
        }
        Insert: {
          id?: string
          asset_id: string
          user_id: string
          value: number
          created_at?: string
        }
        Update: { value?: number }
      }
      comments: {
        Row: {
          id: string
          asset_id: string
          user_id: string
          body: string
          created_at: string
        }
        Insert: {
          id?: string
          asset_id: string
          user_id: string
          body: string
          created_at?: string
        }
        Update: { body?: string }
      }
      approvals: {
        Row: {
          id: string
          asset_id: string
          user_id: string
          state: 'approved' | 'pending' | 'changes' | 'none'
          note: string | null
          created_at: string
        }
        Insert: {
          id?: string
          asset_id: string
          user_id: string
          state?: 'approved' | 'pending' | 'changes' | 'none'
          note?: string | null
          created_at?: string
        }
        Update: {
          state?: 'approved' | 'pending' | 'changes' | 'none'
          note?: string | null
        }
      }
      activity: {
        Row: {
          id: string
          asset_id: string | null
          user_id: string | null
          action: string
          created_at: string
        }
        Insert: {
          id?: string
          asset_id?: string | null
          user_id?: string | null
          action: string
          created_at?: string
        }
        Update: { action?: string }
      }
      asset_events: {
        Row: {
          id: string
          asset_id: string
          event_type: 'view' | 'download'
          user_id: string | null
          role: string
          created_at: string
        }
        Insert: {
          id?: string
          asset_id: string
          event_type: 'view' | 'download'
          user_id?: string | null
          role?: string
          created_at?: string
        }
        Update: {
          event_type?: 'view' | 'download'
          user_id?: string | null
          role?: string
        }
      }
    }
    Views: Record<string, never>
  }
}

// asset_stats view — used with explicit casts in assetService
export interface AssetStats {
  id: string
  avg_rating: number
  rating_count: number
  comment_count: number
}

export type ClientRow   = Database['public']['Tables']['clients']['Row']
export type ProfileRow  = Database['public']['Tables']['profiles']['Row']
export type TagRow      = Database['public']['Tables']['tags']['Row']
export type AssetRow    = Database['public']['Tables']['assets']['Row']
export type RatingRow   = Database['public']['Tables']['ratings']['Row']
export type CommentRow  = Database['public']['Tables']['comments']['Row']
export type ApprovalRow = Database['public']['Tables']['approvals']['Row']
export type ActivityRow = Database['public']['Tables']['activity']['Row']
