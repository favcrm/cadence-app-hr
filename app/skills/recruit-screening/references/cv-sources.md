# How a CV reaches you

Checked against the hosted board's chat upload code. The `documents_intake` tool is not available on a hosted board: do not call it.

- The candidate's `cv_text` field, when the owner pasted or saved it.
- A PDF, Word, Excel or text file the owner attaches in chat: read it with `chat_attachment_read` (the attachment id is in the message). That returns extracted text, in windows. Page on until you have all of it.
- A photo of a CV (PNG, JPEG, WebP) is shown as an image only when the board's model accepts images; there is no OCR and the tool returns no pixels. If you cannot see it, say so and ask the owner to paste the text.
- A scanned PDF with no text layer reads as empty. Ask for the text.
