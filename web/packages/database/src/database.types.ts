export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      activity: {
        Row: {
          action: string
          asset_id: string | null
          created_at: string
          id: string
          user_id: string | null
        }
        Insert: {
          action: string
          asset_id?: string | null
          created_at?: string
          id?: string
          user_id?: string | null
        }
        Update: {
          action?: string
          asset_id?: string | null
          created_at?: string
          id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "activity_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "asset_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      approvals: {
        Row: {
          asset_id: string
          created_at: string
          id: string
          note: string | null
          state: string
          user_id: string
        }
        Insert: {
          asset_id: string
          created_at?: string
          id?: string
          note?: string | null
          state?: string
          user_id: string
        }
        Update: {
          asset_id?: string
          created_at?: string
          id?: string
          note?: string | null
          state?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "approvals_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "asset_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approvals_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_events: {
        Row: {
          asset_id: string
          created_at: string
          event_type: string
          id: string
          role: string
          user_id: string | null
        }
        Insert: {
          asset_id: string
          created_at?: string
          event_type: string
          id?: string
          role?: string
          user_id?: string | null
        }
        Update: {
          asset_id?: string
          created_at?: string
          event_type?: string
          id?: string
          role?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "asset_events_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "asset_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_events_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      assets: {
        Row: {
          angles: string[]
          child_id: string | null
          client_id: string
          created_at: string
          download_key: string | null
          download_url: string | null
          download_urls: Json
          entities: string[]
          formats: string[]
          id: string
          latest: boolean
          name: string
          parent_id: string | null
          perm: string
          primary_angle_id: string | null
          primary_entity_id: string | null
          primary_format_id: string | null
          rename_status: string
          shortcode: string
          stable_id: string | null
          status: string
          tags: string[]
          thumbnail_url: string | null
          updated_at: string
          variant_of: string | null
          version: string
          year_month: string | null
        }
        Insert: {
          angles?: string[]
          child_id?: string | null
          client_id: string
          created_at?: string
          download_key?: string | null
          download_url?: string | null
          download_urls?: Json
          entities?: string[]
          formats?: string[]
          id?: string
          latest?: boolean
          name?: string
          parent_id?: string | null
          perm?: string
          primary_angle_id?: string | null
          primary_entity_id?: string | null
          primary_format_id?: string | null
          rename_status?: string
          shortcode: string
          stable_id?: string | null
          status?: string
          tags?: string[]
          thumbnail_url?: string | null
          updated_at?: string
          variant_of?: string | null
          version?: string
          year_month?: string | null
        }
        Update: {
          angles?: string[]
          child_id?: string | null
          client_id?: string
          created_at?: string
          download_key?: string | null
          download_url?: string | null
          download_urls?: Json
          entities?: string[]
          formats?: string[]
          id?: string
          latest?: boolean
          name?: string
          parent_id?: string | null
          perm?: string
          primary_angle_id?: string | null
          primary_entity_id?: string | null
          primary_format_id?: string | null
          rename_status?: string
          shortcode?: string
          stable_id?: string | null
          status?: string
          tags?: string[]
          thumbnail_url?: string | null
          updated_at?: string
          variant_of?: string | null
          version?: string
          year_month?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "asset_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_primary_angle_id_fkey"
            columns: ["primary_angle_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_primary_entity_id_fkey"
            columns: ["primary_entity_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_primary_format_id_fkey"
            columns: ["primary_format_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_variant_of_fkey"
            columns: ["variant_of"]
            isOneToOne: false
            referencedRelation: "asset_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_variant_of_fkey"
            columns: ["variant_of"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      client_members: {
        Row: {
          client_id: string
          created_at: string
          user_id: string
        }
        Insert: {
          client_id: string
          created_at?: string
          user_id: string
        }
        Update: {
          client_id?: string
          created_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_members_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          accent: string
          cloud_destinations: Json
          created_at: string
          dimension_labels: Json
          domain_whitelist: string[]
          id: string
          identity_migrated: boolean
          initials: string
          logo_url: string | null
          name: string
          portal_bg: string | null
          slug: string | null
          website: string | null
        }
        Insert: {
          accent?: string
          cloud_destinations?: Json
          created_at?: string
          dimension_labels?: Json
          domain_whitelist?: string[]
          id?: string
          identity_migrated?: boolean
          initials?: string
          logo_url?: string | null
          name: string
          portal_bg?: string | null
          slug?: string | null
          website?: string | null
        }
        Update: {
          accent?: string
          cloud_destinations?: Json
          created_at?: string
          dimension_labels?: Json
          domain_whitelist?: string[]
          id?: string
          identity_migrated?: boolean
          initials?: string
          logo_url?: string | null
          name?: string
          portal_bg?: string | null
          slug?: string | null
          website?: string | null
        }
        Relationships: []
      }
      comments: {
        Row: {
          asset_id: string
          body: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          asset_id: string
          body: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          asset_id?: string
          body?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "asset_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          client_id: string | null
          company: string
          country: string
          created_at: string
          id: string
          industry: string
          initials: string
          name: string
          role: string
        }
        Insert: {
          client_id?: string | null
          company?: string
          country?: string
          created_at?: string
          id: string
          industry?: string
          initials?: string
          name?: string
          role?: string
        }
        Update: {
          client_id?: string | null
          company?: string
          country?: string
          created_at?: string
          id?: string
          industry?: string
          initials?: string
          name?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      ratings: {
        Row: {
          asset_id: string
          created_at: string
          id: string
          user_id: string
          value: number
        }
        Insert: {
          asset_id: string
          created_at?: string
          id?: string
          user_id: string
          value: number
        }
        Update: {
          asset_id?: string
          created_at?: string
          id?: string
          user_id?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "ratings_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "asset_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ratings_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      rename_tasks: {
        Row: {
          asset_id: string | null
          client_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          id: string
          payload: Json
          status: string
          task_type: string
        }
        Insert: {
          asset_id?: string | null
          client_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          payload?: Json
          status?: string
          task_type: string
        }
        Update: {
          asset_id?: string | null
          client_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          payload?: Json
          status?: string
          task_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "rename_tasks_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "asset_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rename_tasks_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rename_tasks_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      tags: {
        Row: {
          client_id: string | null
          created_at: string
          dimension: string
          id: string
          key: string | null
          name: string
          parent_id: string | null
          shortcode: string | null
          sort_order: number
        }
        Insert: {
          client_id?: string | null
          created_at?: string
          dimension: string
          id?: string
          key?: string | null
          name: string
          parent_id?: string | null
          shortcode?: string | null
          sort_order?: number
        }
        Update: {
          client_id?: string | null
          created_at?: string
          dimension?: string
          id?: string
          key?: string | null
          name?: string
          parent_id?: string | null
          shortcode?: string | null
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "tags_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tags_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
        ]
      }
      version_history: {
        Row: {
          asset_id: string
          created_at: string
          date: string | null
          file_url: string | null
          id: string
          status: string
          version: string
          version_label: string
        }
        Insert: {
          asset_id: string
          created_at?: string
          date?: string | null
          file_url?: string | null
          id?: string
          status?: string
          version: string
          version_label?: string
        }
        Update: {
          asset_id?: string
          created_at?: string
          date?: string | null
          file_url?: string | null
          id?: string
          status?: string
          version?: string
          version_label?: string
        }
        Relationships: [
          {
            foreignKeyName: "version_history_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "asset_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "version_history_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      asset_stats: {
        Row: {
          avg_rating: number | null
          comment_count: number | null
          id: string | null
          rating_count: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      check_email_auth: { Args: { p_email: string }; Returns: string }
      get_all_profiles: {
        Args: never
        Returns: {
          client_id: string
          client_name: string
          created_at: string
          email: string
          id: string
          initials: string
          name: string
          role: string
        }[]
      }
      get_client_portal: {
        Args: { p_slug: string }
        Returns: {
          accent: string
          id: string
          initials: string
          logo_url: string
          name: string
          portal_bg: string
        }[]
      }
      get_user_client_members: {
        Args: { p_user_id: string }
        Returns: string[]
      }
      is_admin: { Args: never; Returns: boolean }
      is_staff: { Args: never; Returns: boolean }
      my_client_id: { Args: never; Returns: string }
      my_member_client_ids: { Args: never; Returns: string[] }
      update_user_access: {
        Args: {
          p_client_id?: string
          p_member_client_ids?: string[]
          p_role: string
          p_user_id: string
        }
        Returns: undefined
      }
      update_user_role: {
        Args: { p_role: string; p_user_id: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

