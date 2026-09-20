import { contract } from "@/lib/api";

export default function Home() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">homeparentcontrol</h1>
      <p className="mt-2 text-sm text-gray-600">
        Scaffold only. Contract {contract.major} minor {contract.minor}.
      </p>
    </main>
  );
}
