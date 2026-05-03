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
      bridge_account_members: {
        Row: {
          account_id: string
          created_at: string
          role: string
          user_id: string
        }
        Insert: {
          account_id: string
          created_at?: string
          role?: string
          user_id: string
        }
        Update: {
          account_id?: string
          created_at?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bridge_account_members_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bridge_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      bridge_accounts: {
        Row: {
          created_at: string
          display_name: string
          id: string
          owner_user_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string
          id?: string
          owner_user_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string
          id?: string
          owner_user_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      bridge_commands: {
        Row: {
          account_id: string
          attachments: Json
          body: string | null
          claimed_at: string | null
          claimed_by_device_id: string | null
          completed_at: string | null
          created_at: string
          error: string | null
          id: string
          kind: string
          requested_by: string
          session_id: string | null
          status: string
        }
        Insert: {
          account_id: string
          attachments?: Json
          body?: string | null
          claimed_at?: string | null
          claimed_by_device_id?: string | null
          completed_at?: string | null
          created_at?: string
          error?: string | null
          id?: string
          kind?: string
          requested_by: string
          session_id?: string | null
          status?: string
        }
        Update: {
          account_id?: string
          attachments?: Json
          body?: string | null
          claimed_at?: string | null
          claimed_by_device_id?: string | null
          completed_at?: string | null
          created_at?: string
          error?: string | null
          id?: string
          kind?: string
          requested_by?: string
          session_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "bridge_commands_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bridge_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bridge_commands_claimed_by_device_id_fkey"
            columns: ["claimed_by_device_id"]
            isOneToOne: false
            referencedRelation: "bridge_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bridge_commands_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "bridge_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      bridge_devices: {
        Row: {
          account_id: string
          created_at: string
          device_name: string
          id: string
          last_seen_at: string | null
          paired_at: string | null
          platform: string | null
          public_key: string | null
          status: string
        }
        Insert: {
          account_id: string
          created_at?: string
          device_name: string
          id?: string
          last_seen_at?: string | null
          paired_at?: string | null
          platform?: string | null
          public_key?: string | null
          status?: string
        }
        Update: {
          account_id?: string
          created_at?: string
          device_name?: string
          id?: string
          last_seen_at?: string | null
          paired_at?: string | null
          platform?: string | null
          public_key?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "bridge_devices_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bridge_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      bridge_messages: {
        Row: {
          account_id: string
          attachments: Json
          body: string | null
          created_at: string
          event_payload: Json
          event_type: string | null
          id: string
          provider_message_id: string | null
          role: string
          session_id: string
        }
        Insert: {
          account_id: string
          attachments?: Json
          body?: string | null
          created_at?: string
          event_payload?: Json
          event_type?: string | null
          id?: string
          provider_message_id?: string | null
          role: string
          session_id: string
        }
        Update: {
          account_id?: string
          attachments?: Json
          body?: string | null
          created_at?: string
          event_payload?: Json
          event_type?: string | null
          id?: string
          provider_message_id?: string | null
          role?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bridge_messages_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bridge_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bridge_messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "bridge_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      bridge_pairing_codes: {
        Row: {
          account_id: string
          code_hash: string
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
        }
        Insert: {
          account_id: string
          code_hash: string
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
        }
        Update: {
          account_id?: string
          code_hash?: string
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bridge_pairing_codes_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bridge_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      bridge_sessions: {
        Row: {
          account_id: string
          activity_at: string
          created_at: string
          id: string
          metadata: Json
          provider: string
          provider_session_id: string
          status: string
          title: string
          updated_at: string
          workspace_path: string | null
        }
        Insert: {
          account_id: string
          activity_at?: string
          created_at?: string
          id?: string
          metadata?: Json
          provider?: string
          provider_session_id: string
          status?: string
          title?: string
          updated_at?: string
          workspace_path?: string | null
        }
        Update: {
          account_id?: string
          activity_at?: string
          created_at?: string
          id?: string
          metadata?: Json
          provider?: string
          provider_session_id?: string
          status?: string
          title?: string
          updated_at?: string
          workspace_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bridge_sessions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "bridge_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      counter: {
        Row: {
          id: number
          value: number
        }
        Insert: {
          id?: number
          value?: number
        }
        Update: {
          id?: number
          value?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      can_access_bridge_account: {
        Args: { target_account_id: string }
        Returns: boolean
      }
      consume_bridge_pairing_code: {
        Args: { pairing_code: string }
        Returns: string
      }
      create_bridge_account: {
        Args: { display_name?: string }
        Returns: {
          created_at: string
          display_name: string
          id: string
          owner_user_id: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bridge_accounts"
          isOneToOne: true
          isSetofReturn: false
        }
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
  public: {
    Enums: {},
  },
} as const
