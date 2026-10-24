import express, { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key';

interface UserPayload {
  userId: string;
  schoolId: string;
  role: 'ADMIN' | 'REGISTRAR' | 'TEACHER';
}

declare global {
  namespace Express {
    interface Request {
      user?: UserPayload;
    }
  }
}

const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied: No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as UserPayload;
    req.user = decoded;
    next();
  } catch (err) {
    res.status(403).json({ error: 'Invalid token' });
  }
};

export interface AssessmentScore {
  score: number | null;
  maxScore: number;
  weightPercentage: number;
  status: 'SUBMITTED' | 'MISSING' | 'EXCUSED' | 'ABSENT';
}

export function calculateSubjectTotal(assessments: AssessmentScore[]): {
  weightedTotal: number;
  letterGrade: string;
  isIncomplete: boolean;
} {
  let totalWeightedScore = 0;
  let totalWeightEvaluated = 0;
  let isIncomplete = false;

  for (const item of assessments) {
    if (item.status === 'EXCUSED') continue;
    if (item.status === 'MISSING' || item.score === null) {
      isIncomplete = true;
      continue;
    }

    const effectiveScore = item.status === 'ABSENT' ? 0 : item.score;
    const itemPercentage = (effectiveScore / item.maxScore) * item.weightPercentage;
    
    totalWeightedScore += itemPercentage;
    totalWeightEvaluated += item.weightPercentage;
  }

  let letterGrade = 'F';
  if (totalWeightedScore >= 90) letterGrade = 'A';
  else if (totalWeightedScore >= 80) letterGrade = 'B';
  else if (totalWeightedScore >= 70) letterGrade = 'C';
  else if (totalWeightedScore >= 60) letterGrade = 'D';

  return {
    weightedTotal: Math.round(totalWeightedScore * 100) / 100,
    letterGrade,
    isIncomplete
  };
}

app.post('/api/marks/batch', authenticate, async (req: Request, res: Response) => {
  const { assessmentId, marks } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    for (const entry of marks) {
      await client.query(
        `INSERT INTO marks (school_id, assessment_id, student_id, score, status, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
         ON CONFLICT (assessment_id, student_id)
         DO UPDATE SET score = EXCLUDED.score, status = EXCLUDED.status, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
        [req.user!.schoolId, assessmentId, entry.studentId, entry.score, entry.status || 'SUBMITTED', req.user!.userId]
      );
    }
    await client.query('COMMIT');
    res.json({ message: 'Marks updated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: (err as Error).message });
  } finally {
    client.release();
  }
});

app.get('/api/reports/section/:sectionId/subject/:subjectId', authenticate, async (req: Request, res: Response) => {
  const { sectionId, subjectId } = req.params;

  try {
    const query = `
      SELECT 
        s.id as student_id,
        s.first_name,
        s.last_name,
        a.id as assessment_id,
        a.max_score,
        a.weight_percentage,
        m.score,
        m.status
      FROM students s
      JOIN enrollments e ON s.id = e.student_id
      JOIN assessments a ON a.section_id = e.section_id
      LEFT JOIN marks m ON m.assessment_id = a.id AND m.student_id = s.id
      WHERE e.section_id = $1 AND a.subject_id = $2 AND s.school_id = $3
    `;
    const { rows } = await pool.query(query, [sectionId, subjectId, req.user!.schoolId]);

    const studentMap: Record<string, any> = {};
    for (const row of rows) {
      if (!studentMap[row.student_id]) {
        studentMap[row.student_id] = {
          studentId: row.student_id,
          name: `${row.first_name} ${row.last_name}`,
          assessments: []
        };
      }
      studentMap[row.student_id].assessments.push({
        score: row.score !== null ? parseFloat(row.score) : null,
        maxScore: parseFloat(row.max_score),
        weightPercentage: parseFloat(row.weight_percentage),
        status: row.status || 'MISSING'
      });
    }

    const report = Object.values(studentMap).map((student: any) => {
      const result = calculateSubjectTotal(student.assessments);
      return {
        studentId: student.studentId,
        name: student.name,
        totalScore: result.weightedTotal,
        grade: result.letterGrade,
        isIncomplete: result.isIncomplete
      };
    });

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`School Records Backend running on port ${PORT}`));
