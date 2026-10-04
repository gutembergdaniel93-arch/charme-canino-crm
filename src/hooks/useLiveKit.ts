import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { generateRoomName, getMeetUrl } from '@/lib/livekit';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';

export interface StartMeetingParams {
  title: string;
  lead_id?: string;
  organization_id?: string;
  activity_id?: string;
  meeting_type?: string; // 'cs_meeting' | 'sales_call' | 'onboarding' | 'internal'
}

export interface StartMeetingResult {
  meetingId: string;
  roomName: string;
  meetUrl: string;
  hostUrl: string;
}

/**
 * Hook pra iniciar uma reunião via LiveKit.
 * Cria registro em `meetings`, gera roomName, retorna URLs.
 */
export function useLiveKit() {
  const { teamMember } = useAuth();
  const { toast } = useToast();
  const [isCreating, setIsCreating] = useState(false);

  const startMeeting = async (params: StartMeetingParams): Promise<StartMeetingResult | null> => {
    setIsCreating(true);
    try {
      const roomName = generateRoomName(params.meeting_type || 'meet');

      const { data: meeting, error } = await supabase
        .from('meetings')
        .insert({
          title: params.title,
          lead_id: params.lead_id || null,
          organization_id: params.organization_id || null,
          activity_id: params.activity_id || null,
          meeting_type: params.meeting_type || 'sales_call',
          status: 'active',
          started_at: new Date().toISOString(),
          livekit_room_name: roomName,
          recording_status: 'pending',
          created_by: teamMember?.id || null,
          meeting_link: getMeetUrl(roomName),
          participants: teamMember ? [{ id: teamMember.id, name: teamMember.name, role: 'host' }] : [],
          transcriptions: [],
        })
        .select()
        .single();

      if (error) throw error;

      const meetUrl = getMeetUrl(roomName);
      const hostParams = new URLSearchParams({
        role: 'host',
        name: teamMember?.name || 'Host',
        ...(params.lead_id ? { lead_id: params.lead_id } : {}),
        ...(params.organization_id ? { org_id: params.organization_id } : {}),
        meeting_id: meeting.id,
      });
      const hostUrl = `${meetUrl}?${hostParams.toString()}`;

      return {
        meetingId: meeting.id,
        roomName,
        meetUrl,
        hostUrl,
      };
    } catch (err: any) {
      console.error('startMeeting error:', err);
      toast({
        title: 'Erro ao criar reunião',
        description: err.message,
        variant: 'destructive',
      });
      return null;
    } finally {
      setIsCreating(false);
    }
  };

  return { startMeeting, isCreating };
}
