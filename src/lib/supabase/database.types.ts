export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      albums: {
        Row: {
          created_at: string
          id: string
          image_url: string | null
          name: string
          release_date: string | null
          release_year: number | null
          total_tracks: number | null
        }
        Insert: {
          created_at?: string
          id: string
          image_url?: string | null
          name: string
          release_date?: string | null
          release_year?: number | null
          total_tracks?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          image_url?: string | null
          name?: string
          release_date?: string | null
          release_year?: number | null
          total_tracks?: number | null
        }
        Relationships: []
      }
      artist_similarity: {
        Row: {
          artist_id: string
          score: number
          similar_artist_id: string
          source: string
        }
        Insert: {
          artist_id: string
          score: number
          similar_artist_id: string
          source: string
        }
        Update: {
          artist_id?: string
          score?: number
          similar_artist_id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "artist_similarity_artist_id_fkey"
            columns: ["artist_id"]
            isOneToOne: false
            referencedRelation: "artists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artist_similarity_similar_artist_id_fkey"
            columns: ["similar_artist_id"]
            isOneToOne: false
            referencedRelation: "artists"
            referencedColumns: ["id"]
          },
        ]
      }
      artist_tags: {
        Row: {
          artist_id: string
          tag_id: number
          weight: number
        }
        Insert: {
          artist_id: string
          tag_id: number
          weight?: number
        }
        Update: {
          artist_id?: string
          tag_id?: number
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "artist_tags_artist_id_fkey"
            columns: ["artist_id"]
            isOneToOne: false
            referencedRelation: "artists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artist_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
        ]
      }
      artists: {
        Row: {
          created_at: string
          enriched_at: string | null
          id: string
          image_url: string | null
          mb_artist_mbid: string | null
          name: string
          spotify_genres: string[]
          updated_at: string
        }
        Insert: {
          created_at?: string
          enriched_at?: string | null
          id: string
          image_url?: string | null
          mb_artist_mbid?: string | null
          name: string
          spotify_genres?: string[]
          updated_at?: string
        }
        Update: {
          created_at?: string
          enriched_at?: string | null
          id?: string
          image_url?: string | null
          mb_artist_mbid?: string | null
          name?: string
          spotify_genres?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      generation_jobs: {
        Row: {
          batch_id: string | null
          created_at: string
          engine: string
          error: string | null
          id: string
          name: string | null
          progress: number
          result: Json | null
          status: Database["public"]["Enums"]["generation_status"]
          step: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          batch_id?: string | null
          created_at?: string
          engine: string
          error?: string | null
          id?: string
          name?: string | null
          progress?: number
          result?: Json | null
          status?: Database["public"]["Enums"]["generation_status"]
          step?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          batch_id?: string | null
          created_at?: string
          engine?: string
          error?: string | null
          id?: string
          name?: string | null
          progress?: number
          result?: Json | null
          status?: Database["public"]["Enums"]["generation_status"]
          step?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      listens: {
        Row: {
          completion: number | null
          context_uri: string | null
          created_at: string
          id: number
          ms_played: number | null
          played_at: string
          source: Database["public"]["Enums"]["listen_source"]
          track_id: string
          user_id: string
        }
        Insert: {
          completion?: number | null
          context_uri?: string | null
          created_at?: string
          id?: never
          ms_played?: number | null
          played_at: string
          source: Database["public"]["Enums"]["listen_source"]
          track_id: string
          user_id: string
        }
        Update: {
          completion?: number | null
          context_uri?: string | null
          created_at?: string
          id?: never
          ms_played?: number | null
          played_at?: string
          source?: Database["public"]["Enums"]["listen_source"]
          track_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "listens_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      playlists: {
        Row: {
          created_at: string
          id: string
          name: string
          spotify_playlist_id: string
          track_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          spotify_playlist_id: string
          track_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          spotify_playlist_id?: string
          track_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      ratings: {
        Row: {
          created_at: string
          ms_at_rating: number | null
          rating: number
          track_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          ms_at_rating?: number | null
          rating: number
          track_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          ms_at_rating?: number | null
          rating?: number
          track_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ratings_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      reco_batches: {
        Row: {
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["reco_batch_kind"]
          name: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: Database["public"]["Enums"]["reco_batch_kind"]
          name: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["reco_batch_kind"]
          name?: string
          user_id?: string
        }
        Relationships: []
      }
      recommendations: {
        Row: {
          batch_id: string
          created_at: string
          engine: Database["public"]["Enums"]["reco_engine"]
          exploration: number
          id: number
          reasons: Json
          score: number
          served_at: string | null
          status: Database["public"]["Enums"]["reco_status"]
          track_id: string
          user_id: string
        }
        Insert: {
          batch_id: string
          created_at?: string
          engine?: Database["public"]["Enums"]["reco_engine"]
          exploration?: number
          id?: never
          reasons?: Json
          score: number
          served_at?: string | null
          status?: Database["public"]["Enums"]["reco_status"]
          track_id: string
          user_id: string
        }
        Update: {
          batch_id?: string
          created_at?: string
          engine?: Database["public"]["Enums"]["reco_engine"]
          exploration?: number
          id?: never
          reasons?: Json
          score?: number
          served_at?: string | null
          status?: Database["public"]["Enums"]["reco_status"]
          track_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recommendations_batch_fk"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "reco_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recommendations_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      saved_tracks: {
        Row: {
          added_at: string
          track_id: string
          user_id: string
        }
        Insert: {
          added_at: string
          track_id: string
          user_id: string
        }
        Update: {
          added_at?: string
          track_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "saved_tracks_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      spotify_accounts: {
        Row: {
          access_expires_at: string
          access_token_enc: string
          authorized_at: string
          country: string | null
          created_at: string
          display_name: string | null
          email: string | null
          last_error: string | null
          last_refreshed_at: string | null
          product: string | null
          refresh_token_enc: string
          scopes: string[]
          spotify_user_id: string
          status: Database["public"]["Enums"]["spotify_account_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          access_expires_at: string
          access_token_enc: string
          authorized_at?: string
          country?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          last_error?: string | null
          last_refreshed_at?: string | null
          product?: string | null
          refresh_token_enc: string
          scopes?: string[]
          spotify_user_id: string
          status?: Database["public"]["Enums"]["spotify_account_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          access_expires_at?: string
          access_token_enc?: string
          authorized_at?: string
          country?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          last_error?: string | null
          last_refreshed_at?: string | null
          product?: string | null
          refresh_token_enc?: string
          scopes?: string[]
          spotify_user_id?: string
          status?: Database["public"]["Enums"]["spotify_account_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sync_state: {
        Row: {
          consecutive_failures: number
          cursor: string | null
          job: string
          last_error: string | null
          last_run_at: string | null
          last_success_at: string | null
          user_id: string
        }
        Insert: {
          consecutive_failures?: number
          cursor?: string | null
          job: string
          last_error?: string | null
          last_run_at?: string | null
          last_success_at?: string | null
          user_id: string
        }
        Update: {
          consecutive_failures?: number
          cursor?: string | null
          job?: string
          last_error?: string | null
          last_run_at?: string | null
          last_success_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      tags: {
        Row: {
          id: number
          name: string
          source: string
        }
        Insert: {
          id?: number
          name: string
          source: string
        }
        Update: {
          id?: number
          name?: string
          source?: string
        }
        Relationships: []
      }
      top_items: {
        Row: {
          captured_on: string
          entity_id: string
          entity_type: string
          rank: number
          time_range: Database["public"]["Enums"]["top_time_range"]
          user_id: string
        }
        Insert: {
          captured_on?: string
          entity_id: string
          entity_type: string
          rank: number
          time_range: Database["public"]["Enums"]["top_time_range"]
          user_id: string
        }
        Update: {
          captured_on?: string
          entity_id?: string
          entity_type?: string
          rank?: number
          time_range?: Database["public"]["Enums"]["top_time_range"]
          user_id?: string
        }
        Relationships: []
      }
      track_artists: {
        Row: {
          artist_id: string
          position: number
          track_id: string
        }
        Insert: {
          artist_id: string
          position?: number
          track_id: string
        }
        Update: {
          artist_id?: string
          position?: number
          track_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "track_artists_artist_id_fkey"
            columns: ["artist_id"]
            isOneToOne: false
            referencedRelation: "artists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "track_artists_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      track_features: {
        Row: {
          acousticness: number | null
          danceability: number | null
          energy: number | null
          fetched_at: string
          instrumentalness: number | null
          key: number | null
          liveness: number | null
          loudness: number | null
          mode: number | null
          source: string
          speechiness: number | null
          tempo: number | null
          track_id: string
          valence: number | null
        }
        Insert: {
          acousticness?: number | null
          danceability?: number | null
          energy?: number | null
          fetched_at?: string
          instrumentalness?: number | null
          key?: number | null
          liveness?: number | null
          loudness?: number | null
          mode?: number | null
          source?: string
          speechiness?: number | null
          tempo?: number | null
          track_id: string
          valence?: number | null
        }
        Update: {
          acousticness?: number | null
          danceability?: number | null
          energy?: number | null
          fetched_at?: string
          instrumentalness?: number | null
          key?: number | null
          liveness?: number | null
          loudness?: number | null
          mode?: number | null
          source?: string
          speechiness?: number | null
          tempo?: number | null
          track_id?: string
          valence?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "track_features_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: true
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      track_tags: {
        Row: {
          tag_id: number
          track_id: string
          weight: number
        }
        Insert: {
          tag_id: number
          track_id: string
          weight?: number
        }
        Update: {
          tag_id?: number
          track_id?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "track_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "track_tags_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      tracks: {
        Row: {
          album_id: string | null
          created_at: string
          duration_ms: number | null
          enriched_at: string | null
          explicit: boolean | null
          id: string
          isrc: string | null
          mb_recording_mbid: string | null
          name: string
          popularity: number | null
          updated_at: string
        }
        Insert: {
          album_id?: string | null
          created_at?: string
          duration_ms?: number | null
          enriched_at?: string | null
          explicit?: boolean | null
          id: string
          isrc?: string | null
          mb_recording_mbid?: string | null
          name: string
          popularity?: number | null
          updated_at?: string
        }
        Update: {
          album_id?: string | null
          created_at?: string
          duration_ms?: number | null
          enriched_at?: string | null
          explicit?: boolean | null
          id?: string
          isrc?: string | null
          mb_recording_mbid?: string | null
          name?: string
          popularity?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tracks_album_id_fkey"
            columns: ["album_id"]
            isOneToOne: false
            referencedRelation: "albums"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      engine_performance: {
        Row: {
          avg_exploration: number | null
          avg_rating: number | null
          engine: Database["public"]["Enums"]["reco_engine"] | null
          loved_count: number | null
          loved_pct: number | null
          rated_count: number | null
          rejected_count: number | null
          user_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      generation_status: "running" | "done" | "failed"
      listen_source: "recently_played" | "playback_sdk" | "now_playing"
      reco_batch_kind: "manual" | "auto_daily" | "auto_refill"
      reco_engine: "algo" | "ai"
      reco_status: "pending" | "served" | "rated" | "skipped" | "dismissed"
      spotify_account_status: "active" | "needs_reauth" | "revoked"
      top_time_range: "short_term" | "medium_term" | "long_term"
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
  public: {
    Enums: {
      generation_status: ["running", "done", "failed"],
      listen_source: ["recently_played", "playback_sdk", "now_playing"],
      reco_batch_kind: ["manual", "auto_daily", "auto_refill"],
      reco_engine: ["algo", "ai"],
      reco_status: ["pending", "served", "rated", "skipped", "dismissed"],
      spotify_account_status: ["active", "needs_reauth", "revoked"],
      top_time_range: ["short_term", "medium_term", "long_term"],
    },
  },
} as const
