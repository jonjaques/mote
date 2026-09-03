import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js'

import { projectFS } from './fs'

export async function exportProject(): Promise<void> {
  const writer = new ZipWriter(new BlobWriter('application/zip'))

  for (const file of projectFS.list()) {
    await writer.add(file.path, new TextReader(file.content))
  }

  const blob = await writer.close()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'mote-project.zip'
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
