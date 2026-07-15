export type { Database, Json } from './database.types.js'

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row']

export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert']

export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update']

import type { Database } from './database.types.js'

export type ClientRow = Tables<'clients'>
export type ProfileRow = Tables<'profiles'>
export type AssetRow = Tables<'assets'>
export type TagRow = Tables<'tags'>
export type RatingRow = Tables<'ratings'>
export type CommentRow = Tables<'comments'>
export type ApprovalRow = Tables<'approvals'>
export type ActivityRow = Tables<'activity'>

/** asset_stats view — queried via explicit select in assetService */
export interface AssetStats {
  id: string
  avg_rating: number
  rating_count: number
  comment_count: number
}
