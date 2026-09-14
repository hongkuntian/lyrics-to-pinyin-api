"use client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CircleAlert } from "lucide-react";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <Card>
      <CardContent className="empty-state" role="alert">
        <CircleAlert size={30} />
        <h1>Records are temporarily unavailable</h1>
        <p>
          We couldn’t load the saved data. Your lyrics and translations have not
          been changed.
        </p>
        <Button variant="outline" onClick={reset}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}
