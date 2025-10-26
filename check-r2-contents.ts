// ABOUTME: Script to check all contents of R2 bucket and count events
// ABOUTME: Lists all files in R2 to find events not in manifest

interface Env {
  EVENT_ARCHIVE: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    console.log('Checking R2 bucket contents...');

    try {
      const results = {
        manifestInfo: null as any,
        eventFiles: [] as string[],
        indexFiles: [] as string[],
        totalEventCount: 0,
        fileDetails: [] as any[]
      };

      // Check manifest
      const manifestObj = await env.EVENT_ARCHIVE.get('manifest.json');
      if (manifestObj) {
        results.manifestInfo = JSON.parse(await manifestObj.text());
      }

      // List all objects in events/ directory
      console.log('Listing events/ directory...');
      let cursor: string | undefined;
      do {
        const listed = await env.EVENT_ARCHIVE.list({
          prefix: 'events/',
          cursor
        });

        for (const obj of listed.objects) {
          results.eventFiles.push(obj.key);

          // Try to read and count events in this file
          const file = await env.EVENT_ARCHIVE.get(obj.key);
          if (file) {
            const text = await file.text();
            const lines = text.split('\n').filter(l => l.trim()).length;
            results.totalEventCount += lines;
            results.fileDetails.push({
              key: obj.key,
              size: obj.size,
              eventCount: lines
            });
          }
        }

        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);

      // List index/id/ directory to count individual event files
      console.log('Listing index/id/ directory...');
      cursor = undefined;
      let idFileCount = 0;
      do {
        const listed = await env.EVENT_ARCHIVE.list({
          prefix: 'index/id/',
          cursor
        });

        idFileCount += listed.objects.length;
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);

      results.indexFiles.push(`index/id/: ${idFileCount} files`);

      console.log('R2 check complete:', results);
      return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      const err = error as Error;
      console.error('R2 check failed:', err);
      return new Response(JSON.stringify({
        success: false,
        error: err.message
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
