export const metadata = { title: "Songs" };
import { read } from "@/lib/data";
import { pageNumber, searchText } from "@/lib/model";
import { PageHeading, Pager, Empty } from "@/components/shared";
import { SongTable } from "@/components/song-table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
export default async function SongsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const p = await searchParams,
    q = searchText(p.q);
  const data = await read((db) => db.songs(q, pageNumber(p.page)));
  return (
    <>
      <PageHeading
        eyebrow="PRESERVED FOR REUSE"
        title="Songs"
        description="Inspect the exact lyrics and translations saved for each recording."
      />
      <form className="filter-bar" action="/songs">
        <Input
          key={q}
          name="q"
          defaultValue={q}
          aria-label="Search songs or artists"
          placeholder="Search songs or artists…"
          maxLength={120}
        />
        <Button type="submit">Search</Button>
      </form>
      <Card>
        <CardContent>
          {data.rows.length ? (
            <SongTable rows={data.rows} />
          ) : (
            <Empty
              title="No songs found"
              detail={
                q
                  ? "Try a different song title or artist."
                  : "Saved lyrics will appear after they are opened in Lyra."
              }
            />
          )}
          <Pager {...data} base="/songs" params={{ q }} />
        </CardContent>
      </Card>
      <p className="page-note">
        Saved content counts are available now. Cache-hit rates have not been
        measured yet.
      </p>
    </>
  );
}
