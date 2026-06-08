import type { Column, ColumnType, DataTable, Transform } from "@playcanvas/splat-transform";

type SplatColumnStorage =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

type SplatDataProperty = {
  type: string;
  name: string;
  storage: SplatColumnStorage;
  byteSize: number;
};

type SplatDataElement = {
  name: "vertex";
  count: number;
  properties: SplatDataProperty[];
};

type SplatLoadResult = {
  splatData: SplatData;
  transform: Transform;
};

const columnTypeToSplatType = (colType: ColumnType | null): string => {
  switch (colType) {
    case "int8":
      return "char";
    case "uint8":
      return "uchar";
    case "int16":
      return "short";
    case "uint16":
      return "ushort";
    case "int32":
      return "int";
    case "uint32":
      return "uint";
    case "float32":
      return "float";
    case "float64":
      return "double";
    default:
      return "float";
  }
};

class SplatData {
  readonly elements: SplatDataElement[];
  readonly numSplats: number;

  constructor(elements: SplatDataElement[]) {
    this.elements = elements;
    this.numSplats = elements[0]?.count ?? 0;
  }

  getElement(name: "vertex"): SplatDataElement | undefined {
    return this.elements.find((element) => element.name === name);
  }

  getProp(name: string, elementName: "vertex" = "vertex"): SplatColumnStorage | undefined {
    return this.getElement(elementName)?.properties.find((prop) => prop.name === name)?.storage;
  }

  getFloatProp(name: string): Float32Array {
    const prop = this.getProp(name);
    if (!(prop instanceof Float32Array)) {
      throw new Error(`Expected '${name}' to be a Float32Array.`);
    }
    return prop;
  }

  addProp(name: string, storage: SplatColumnStorage, type = "float"): void {
    this.getElement("vertex")?.properties.push({
      type,
      name,
      storage,
      byteSize: storage.BYTES_PER_ELEMENT,
    });
  }

  getCenters(): Float32Array {
    const x = this.getProp("x") as Float32Array;
    const y = this.getProp("y") as Float32Array;
    const z = this.getProp("z") as Float32Array;
    const centers = new Float32Array(3 * this.numSplats);

    for (let i = 0; i < this.numSplats; ++i) {
      centers[3 * i + 0] = x[i];
      centers[3 * i + 1] = y[i];
      centers[3 * i + 2] = z[i];
    }

    return centers;
  }
}

const dataTableToSplatData = (dataTable: DataTable): SplatData => {
  const properties = dataTable.columns.map((col: Column) => ({
    type: columnTypeToSplatType(col.dataType),
    name: col.name,
    storage: col.data as SplatColumnStorage,
    byteSize: col.data.BYTES_PER_ELEMENT,
  }));

  const splatData = new SplatData([
    {
      name: "vertex",
      count: dataTable.numRows,
      properties,
    },
  ]);

  if (
    splatData.getProp("scale_0") &&
    splatData.getProp("scale_1") &&
    !splatData.getProp("scale_2")
  ) {
    const scale2 = new Float32Array(splatData.numSplats).fill(Math.log(1e-6));
    splatData.addProp("scale_2", scale2);

    const props = splatData.getElement("vertex")?.properties;
    if (props) {
      props.splice(
        props.findIndex((prop) => prop.name === "scale_1") + 1,
        0,
        props.splice(props.length - 1, 1)[0],
      );
    }
  }

  return splatData;
};

export { dataTableToSplatData, SplatData };
export type { SplatColumnStorage, SplatDataProperty, SplatLoadResult };
