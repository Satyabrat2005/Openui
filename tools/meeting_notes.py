"""
Meeting Notes Tool — Transcription, summarization, action items, and notes management.
"""

import os
import time
from typing import Dict, Any, Optional
from tools.base import BaseTool
from core.helpers import format_tool_result, ensure_dir


class MeetingNotesTool(BaseTool):
    """Generate notes, summaries, and action items from a meeting."""

    def __init__(self, config, meeting_manager=None, router=None):
        self.config = config
        self.meeting_manager = meeting_manager
        self.router = router

    @property
    def name(self) -> str:
        return "meeting_notes"

    @property
    def description(self) -> str:
        return (
            "Summarize meeting transcripts, extract action items, and save meeting notes. "
            "Arguments: action ('summarize' or 'save'), output_dir (optional)"
        )

    def execute(self, args: Dict[str, Any]) -> str:
        action = args.get("action", "summarize").lower()
        output_dir = args.get("output_dir", "meeting_outputs")

        if not self.meeting_manager:
            return "ERROR: Meeting manager not configured."

        session = self.meeting_manager.get_active_session()
        if not session:
            # Check if there is a recently ended session
            # For simplicity, we can let them summarize/save the last session
            return "ERROR: No active meeting session found."

        if action == "summarize":
            return self._summarize_session(session)
        elif action == "save":
            return self._save_session(session, output_dir)
        else:
            return f"ERROR: Unknown action '{action}'."

    def _summarize_session(self, session) -> str:
        transcript_text = self.meeting_manager.get_transcript_text()
        if not transcript_text or transcript_text == "No transcript entries yet.":
            return "ERROR: Cannot summarize. Transcript is empty."

        if not self.router:
            return "ERROR: Router not available for summarization."

        prompt = f"""You are an expert meeting assistant. Below is the transcript of a meeting.
Generate a comprehensive meeting summary that includes:
1. Executive Summary: High-level overview of the meeting purpose and outcomes.
2. Key Discussion Points: Detailed breakdown of topics discussed.
3. Decisions Made: Clear list of agreements and decisions.
4. Action Items: Tasks assigned, who is responsible, and deadlines if mentioned.

TRANSCRIPT:
{transcript_text}

Provide a well-structured markdown summary.
"""
        messages = [
            {"role": "system", "content": "You are a professional meeting minutes writer."},
            {"role": "user", "content": prompt}
        ]

        try:
            response = self.router.chat(messages=messages, temperature=0.2)
            summary = response.content
            # Save summary in session
            session.notes.append({"text": summary, "time": time.time()})
            return format_tool_result(self.name, f"Summary generated successfully:\n\n{summary}")
        except Exception as e:
            return f"ERROR generating summary: {e}"

    def _save_session(self, session, output_dir: str) -> str:
        ensure_dir(output_dir)
        timestamp = time.strftime("%Y%m%d_%H%M%S", time.localtime(session.joined_at))
        safe_url = session.meeting_url.replace("https://", "").replace("/", "_").replace("?", "_")[:50]
        filename = f"meeting_{timestamp}_{safe_url}.md"
        filepath = os.path.join(output_dir, filename)

        transcript_text = self.meeting_manager.get_transcript_text()

        # Build document
        doc = []
        doc.append(f"# Meeting Notes & Summary")
        doc.append(f"- **URL**: {session.meeting_url}")
        doc.append(f"- **Platform**: {session.platform}")
        doc.append(f"- **Date**: {time.ctime(session.joined_at)}")
        doc.append(f"- **Duration**: {int(time.time() - session.joined_at) // 60} minutes")
        doc.append("\n---\n")

        if session.notes:
            doc.append(f"## Summary")
            for note in session.notes:
                doc.append(note["text"])
                doc.append("")
        else:
            doc.append("## Summary\nNo summary was generated.")

        doc.append("\n---\n")
        doc.append("## Action Items")
        if session.action_items:
            for item in session.action_items:
                assignee = f" (Assignee: {item['assignee']})" if item['assignee'] else ""
                doc.append(f"- [ ] {item['item']}{assignee}")
        else:
            doc.append("No action items recorded.")

        doc.append("\n---\n")
        doc.append("## Full Transcript")
        doc.append(transcript_text)

        content = "\n".join(doc)
        try:
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(content)
            return format_tool_result(
                self.name,
                f"Meeting session saved to: {os.path.abspath(filepath)}\n"
                f"Contains: Summary, Action Items, and Transcript."
            )
        except Exception as e:
            return f"ERROR saving meeting session: {e}"
