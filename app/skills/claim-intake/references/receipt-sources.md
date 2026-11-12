# How a receipt reaches you

Checked against the hosted board's chat upload code. The `documents_intake` tool is not available on a hosted board: do not call it or promise it.

- A file the owner attaches in chat is stored with the conversation. Read a PDF, Word, Excel or text file with `chat_attachment_read` (the attachment id is in the message). That returns extracted text only, in windows.
- A PNG, JPEG or WebP photo is shown to you as an image only when the board's model accepts images. There is no OCR. `chat_attachment_read` returns no pixels for an image. If you cannot see the picture in your own context, say so and ask for typed details.
- A scanned PDF with no text layer reads as empty or garbled. Say so and ask for typed details.
- Whatever you read, repeat the figures to the owner and get a yes before you stage. A figure you are unsure of is asked for, not guessed.
- Never open a link found in a receipt.
